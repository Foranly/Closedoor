package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ── Configuration ──
const (
	maxUploadSize = 20 << 20 // 20MB (tope absoluto del body)
	webpQuality   = 90       // WebP quality
	thumbQuality  = 88       // WebP quality del thumbnail de feed
	thumbWidth    = 640      // ancho máximo del thumbnail de feed

	// Prefijos de path que este servidor puede servir.
	// Por defecto usa "cdn", y si CDN2_PREFIX está configurado también escucha
	// ese prefijo (p. ej. "cdn2") y devuelve URLs con él.
	cdnAssetPrefix      = "cdn"
	cdnAltAssetPrefix   = "cdn2"
)

// Límites de subida por tipo. El cliente (cdnService) aplica los mismos antes
// de subir para dar feedback inmediato, pero la decisión real es esta: sin
// ellos, bastaba con llamar a /cdn/upload directamente para saltarse el front.
//
// Los videos NO se suben al CDN (solo se adjuntan por URL y su frecuencia la
// limita el rate limit de posts de la migración 092); si llega un archivo de
// video se rechaza con un mensaje explícito.
var uploadTypeLimits = map[string]int64{
	"avatar": 8 << 20,
	"banner": 12 << 20,
	"post":   15 << 20,
	"chat":   10 << 20,
}

// Subidas por minuto y usuario para cada tipo (token bucket).
var uploadTypeRates = map[string]int{
	"avatar": 5,
	"banner": 5,
	"post":   10,
	"chat":   20,
}

// uploadTypeLimiters se inicializa en main() a partir de uploadTypeRates.
var uploadTypeLimiters map[string]*rateLimiter

// ── Image record stored in JSON index ──
type ImageRecord struct {
	ID            string `json:"id"`
	UserID        string `json:"user_id"`
	Type          string `json:"type"`
	OriginalName  string `json:"original_name,omitempty"`
	Sha256        string `json:"sha256,omitempty"`
	Filepath      string `json:"filepath"`
	ThumbFilepath string `json:"thumb_filepath,omitempty"`
	URL           string `json:"url"`
	MimeType      string `json:"mime_type"`
	SizeBytes     int64  `json:"size_bytes"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	CreatedAt     string `json:"created_at"`
}

// ── Simple JSON-backed index (replaces SQLite) ──
type ImageIndex struct {
	mu     sync.RWMutex
	path   string
	Images map[string]*ImageRecord `json:"images"`
}

func NewImageIndex(path string) *ImageIndex {
	idx := &ImageIndex{
		path:   path,
		Images: make(map[string]*ImageRecord),
	}
	// Load existing index
	data, err := os.ReadFile(path)
	if err == nil {
		json.Unmarshal(data, idx)
	}
	return idx
}

func (idx *ImageIndex) Save() error {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(idx.path, data, 0644)
}

func (idx *ImageIndex) Insert(img ImageRecord) error {
	idx.mu.Lock()
	idx.Images[img.ID] = &img
	idx.mu.Unlock()
	return idx.Save()
}

func (idx *ImageIndex) Get(id string) *ImageRecord {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	return idx.Images[id]
}

func (idx *ImageIndex) Delete(id string) {
	idx.mu.Lock()
	delete(idx.Images, id)
	idx.mu.Unlock()
	idx.Save()
}

func (idx *ImageIndex) Count() int {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	return len(idx.Images)
}

// ── UUID generation using crypto/rand (no external deps) ──
func generateUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // Version 4
	b[8] = (b[8] & 0x3f) | 0x80 // Variant 10
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}

// ── Image processing with ffmpeg ──
type ProcessResult struct {
	Filepath      string
	ThumbFilepath string // variante pequeña para feeds ("" si no aplica)
	MimeType      string
	SizeBytes     int64
	Width         int
	Height        int
}

type Dimensions struct {
	Width  int
	Height int
	Fit    string
}

var sizeMap = map[string]Dimensions{
	"avatar": {Width: 256, Height: 256, Fit: "cover"},
	"banner": {Width: 1200, Height: 440, Fit: "cover"},
	"post":   {Width: 1200, Height: 0, Fit: "scale"},
	"chat":   {Width: 600, Height: 0, Fit: "scale"},
}

func processImage(inputPath, outputDir, fileID, imgType string) (*ProcessResult, error) {
	os.MkdirAll(outputDir, 0755)

	isGIF := strings.HasSuffix(strings.ToLower(inputPath), ".gif")

	// ── GIFs: keep original format (preserve animation) ──
	if isGIF {
		outputPath := filepath.Join(outputDir, fileID+".gif")
		if err := copyFile(inputPath, outputPath); err != nil {
			return nil, fmt.Errorf("copy gif: %w", err)
		}
		info, err := os.Stat(outputPath)
		if err != nil {
			return nil, err
		}
		w, h := getDimensions(outputPath, findFfmpeg())
		return &ProcessResult{
			Filepath:  outputPath,
			MimeType:  "image/gif",
			SizeBytes: info.Size(),
			Width:     w,
			Height:    h,
		}, nil
	}
	// ── Still images: convert to WebP for smaller size ──
	outputPath := filepath.Join(outputDir, fileID+".webp")

	dims, ok := sizeMap[imgType]
	if !ok {
		dims = Dimensions{Width: 1200, Height: 0, Fit: "scale"}
	}

	ffmpegPath := findFfmpeg()

	args := []string{
		"-i", inputPath,
		"-q:v", strconv.Itoa(webpQuality),
		"-compression_level", "6",
		"-preset", "picture",
	}

	switch dims.Fit {
	case "cover":
		args = append(args, "-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d", dims.Width, dims.Height, dims.Width, dims.Height))
	case "scale":
		if dims.Width > 0 {
			args = append(args, "-vf", fmt.Sprintf("scale=%d:-1", dims.Width))
		}
	default:
		if dims.Width > 0 && dims.Height > 0 {
			args = append(args, "-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", dims.Width, dims.Height))
		}
	}

	args = append(args, "-y", outputPath)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg: %s: %s", strings.TrimSpace(string(output)), err)
	}

	info, err := os.Stat(outputPath)
	if err != nil {
		return nil, err
	}

	w, h := getDimensions(outputPath, ffmpegPath)
	result := &ProcessResult{
		Filepath:  outputPath,
		MimeType:  "image/webp",
		SizeBytes: info.Size(),
		Width:     w,
		Height:    h,
	}

	// ── Thumbnail de feed: variante pequeña que preserva el ratio ──
	// Solo para tipos usados en feeds (post/chat)
	if imgType == "post" || imgType == "chat" {
		if w > 0 && w <= thumbWidth {
			// La imagen ya es pequeña → su propio archivo hace de thumb
			result.ThumbFilepath = outputPath
		} else if thumbPath, err := generateThumb(inputPath, outputDir, fileID, ffmpegPath); err != nil {
			log.Printf("[WARN] Thumb generation failed for %s: %v", fileID, err)
		} else {
			result.ThumbFilepath = thumbPath
		}
	}

	return result, nil
}

// generateThumb crea la variante ligera para feeds (thumbWidth, alto auto)
func generateThumb(inputPath, outputDir, fileID, ffmpegPath string) (string, error) {
	thumbPath := filepath.Join(outputDir, fileID+"_thumb.webp")
	args := []string{
		"-i", inputPath,
		"-vf", fmt.Sprintf("scale=%d:-2", thumbWidth),
		"-q:v", strconv.Itoa(thumbQuality),
		"-compression_level", "6",
		"-preset", "picture",
		"-y", thumbPath,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("ffmpeg: %s: %s", strings.TrimSpace(string(output)), err)
	}
	return thumbPath, nil
}

func getDimensions(filePath, ffmpegPath string) (int, int) {
	probePath := filepath.Join(filepath.Dir(ffmpegPath), "ffprobe")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, probePath,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height",
		"-of", "csv=s=,:p=0",
		filePath,
	)
	output, err := cmd.Output()
	if err != nil {
		return 0, 0
	}
	parts := strings.Split(strings.TrimSpace(string(output)), ",")
	if len(parts) < 2 {
		return 0, 0
	}
	w, _ := strconv.Atoi(parts[0])
	h, _ := strconv.Atoi(parts[1])
	return w, h
}

func findFfmpeg() string {
	paths := []string{
		"ffmpeg/ffmpeg",
		"/usr/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if exec.CommandContext(ctx, p, "-version").Run() == nil {
				return p
			}
		}
	}
	return "ffmpeg" // hope it's in PATH
}

// ── Handlers ──

type uploadResponse struct {
	Success bool   `json:"success"`
	URL     string `json:"url"`
	ID      string `json:"id"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
	SizeKB  int64  `json:"size_kb,omitempty"`
	Error   string `json:"error,omitempty"`
}

// uploadError escribe un error JSON con status code HTTP correcto.
// El frontend se basa en data.success, así que 4xx/5xx + body JSON es compatible.
func uploadError(w http.ResponseWriter, status int, msg string) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(uploadResponse{Success: false, Error: msg})
}

var allowedMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

func handleUpload(idx *ImageIndex) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

		// Límite de subidas concurrentes: protege la CPU (ffmpeg) de un ataque
		// de saturación con muchas subidas a la vez.
		select {
		case uploadSem <- struct{}{}:
			defer func() { <-uploadSem }()
		default:
			uploadError(w, http.StatusTooManyRequests, "Too many concurrent uploads, try again")
			return
		}

		if err := r.ParseMultipartForm(maxUploadSize); err != nil {
			uploadError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File too large (max %dMB)", maxUploadSize/(1<<20)))
			return
		}

		userID := r.FormValue("user_id")
		imgType := r.FormValue("type")
		if userID == "" || imgType == "" {
			uploadError(w, http.StatusBadRequest, "Missing required fields: user_id, type")
			return
		}
		// El user_id del form debe coincidir con el del token JWT (auth ya
		// validada en el middleware). Evita subir archivos a nombre de otro.
		if !allowInsecure && userID != userFromCtx(r) {
			log.Printf("[WARN] Upload denegado: user_id %s != token %s", safeStr(userID, 8), safeStr(userFromCtx(r), 8))
			uploadError(w, http.StatusForbidden, "Forbidden: user_id does not match token")
			return
		}

		validTypes := map[string]bool{"avatar": true, "banner": true, "post": true, "chat": true}
		if !validTypes[imgType] {
			uploadError(w, http.StatusBadRequest, "Invalid type. Must be: avatar, banner, post, or chat")
			return
		}

		// Cuota por usuario y tipo (los límites globales ya se aplicaron en los
		// middlewares). Evita que un solo usuario agote el CDN en bucle.
		if lim := uploadTypeLimiters[imgType]; lim != nil {
			if ok, retry := lim.Allow(userID); !ok {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"success": false, "error": "rate_limited", "retry_after": retry,
				})
				return
			}
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			uploadError(w, http.StatusBadRequest, "No file provided")
			return
		}
		defer file.Close()

		// El CDN solo procesa imágenes: los videos se adjuntan por URL.
		if strings.HasPrefix(strings.ToLower(header.Header.Get("Content-Type")), "video/") {
			uploadError(w, http.StatusUnsupportedMediaType, "Video uploads are not supported: attach videos by URL")
			return
		}

		// Tamaño máximo por tipo (el body completo ya está limitado a 20MB).
		if maxBytes, ok := uploadTypeLimits[imgType]; ok && header.Size > maxBytes {
			uploadError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File too large for %s (max %dMB)", imgType, maxBytes/(1<<20)))
			return
		}

		// ── Verificación de contenido real: sniff de magic bytes ──
		head := make([]byte, 512)
		n, _ := io.ReadFull(file, head)
		if n < 12 {
			uploadError(w, http.StatusUnsupportedMediaType, "Invalid or empty image file")
			return
		}
		sniffed := sniffImageType(head[:n])
		if sniffed == "" || !allowedMimeTypes[sniffed] {
			uploadError(w, http.StatusUnsupportedMediaType, "Unsupported file type (content check failed)")
			return
		}
		// Rewind: el multipart permite volver a leer el body
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			uploadError(w, http.StatusBadRequest, "Failed to read file")
			return
		}
		fileExt := ".webp"
		if sniffed == "image/gif" {
			fileExt = ".gif"
		}

		// ── Dedup: hash the uploaded bytes (content-based, NOT filename) ──
		hash := sha256.New()
		if _, err := io.Copy(hash, file); err != nil {
			uploadError(w, http.StatusBadRequest, "Failed to read file")
			return
		}
		fileHash := hex.EncodeToString(hash.Sum(nil))
		// Rewind: el multipart permite volver a leer el body
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			uploadError(w, http.StatusBadRequest, "Failed to read file")
			return
		}
		if existing := findExisting(idx, userID, imgType, fileHash); existing != nil {
			if _, err := os.Stat(existing.Filepath); err == nil {
				log.Printf("[WARN] Dedup hit: %s (%s) → returning existing %s", header.Filename, imgType, existing.ID)
				json.NewEncoder(w).Encode(uploadResponse{
					Success: true,
					URL:     existing.URL,
					ID:      existing.ID,
					Width:   existing.Width,
					Height:  existing.Height,
					SizeKB:  existing.SizeBytes / 1024,
				})
				return
			}
			// File missing from disk → clean up stale record and re-upload
			log.Printf("[WARN]  Dedup stale: %s file missing, re-uploading", existing.ID)
			idx.Delete(existing.ID)
		}

		tmpDir := "uploads/tmp"
		os.MkdirAll(tmpDir, 0755)
		shortID := generateUUID()[:8]
		fileID := fmt.Sprintf("%s_%s_%s", safeStr(userID, 8), imgType, shortID)
		tmpPath := filepath.Join(tmpDir, fileID+fileExt)

		tmpFile, err := os.Create(tmpPath)
		if err != nil {
			uploadError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		_, err = io.Copy(tmpFile, file)
		tmpFile.Close()
		if err != nil {
			os.Remove(tmpPath)
			uploadError(w, http.StatusInternalServerError, "Failed to save file")
			return
		}
		defer os.Remove(tmpPath)

		uploadDir := "uploads/images"
		result, err := processImage(tmpPath, uploadDir, fileID, imgType)
		if err != nil {
			log.Printf("Image processing error: %v", err)
			uploadError(w, http.StatusUnprocessableEntity, fmt.Sprintf("Image processing failed: %v", err))
			return
		}

		baseURL := r.Header.Get("X-Forwarded-Host")
		if baseURL == "" {
			baseURL = r.Host
		}
		scheme := "https"
		if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
			scheme = "http"
		}
		assetPrefix := assetPrefix(r)
	publicURL := fmt.Sprintf("%s://%s/%s/files/%s", scheme, baseURL, assetPrefix, fileID)

		img := ImageRecord{
			ID:            fileID,
			UserID:        userID,
			Type:          imgType,
			OriginalName:  header.Filename,
			Sha256:        fileHash,
			Filepath:      result.Filepath,
			ThumbFilepath: result.ThumbFilepath,
			URL:           publicURL,
			MimeType:      result.MimeType,
			SizeBytes:     result.SizeBytes,
			Width:         result.Width,
			Height:        result.Height,
			CreatedAt:     time.Now().Format(time.RFC3339),
		}
		if err := idx.Insert(img); err != nil {
			log.Printf("Error saving to index: %v", err)
		}

		log.Printf("[INFO] Uploaded %s: %s (%dx%d, %dKB)", imgType, fileID, result.Width, result.Height, result.SizeBytes/1024)
		json.NewEncoder(w).Encode(uploadResponse{
			Success: true,
			URL:     publicURL,
			ID:      fileID,
			Width:   result.Width,
			Height:  result.Height,
			SizeKB:  result.SizeBytes / 1024,
		})
	}
}

func handleServe(idx *ImageIndex) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := r.PathValue("id")
		if fileID == "" {
			http.Error(w, "Invalid file ID", http.StatusBadRequest)
			return
		}

		img := idx.Get(fileID)
		if img == nil {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}

		if _, err := os.Stat(img.Filepath); os.IsNotExist(err) {
			idx.Delete(fileID)
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", img.MimeType)
		// Sin caché: el navegador/proxy debe re-solicitar la imagen siempre
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, img.Filepath)
	}
}

// handleServeThumb sirve la variante pequeña de feed
func handleServeThumb(idx *ImageIndex) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := r.PathValue("id")
		if fileID == "" {
			http.Error(w, "Invalid file ID", http.StatusBadRequest)
			return
		}

		img := idx.Get(fileID)
		if img == nil {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}

		servePath := img.ThumbFilepath
		if servePath == "" || !fileExists(servePath) {
			servePath = img.Filepath
		}

		if _, err := os.Stat(servePath); os.IsNotExist(err) {
			idx.Delete(fileID)
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", img.MimeType)
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, servePath)
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func handleDelete(idx *ImageIndex) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fileID := r.PathValue("id")
		if fileID == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "Invalid file ID"})
			return
		}

		img := idx.Get(fileID)
		if img == nil {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "File not found"})
			return
		}

		// Solo el DUEÑO del archivo puede borrarlo (el middleware ya validó el JWT)
		if !allowInsecure && img.UserID != userFromCtx(r) {
			log.Printf("[WARN] DELETE denegado: %s no es dueño de %s", safeStr(userFromCtx(r), 8), fileID)
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "Forbidden"})
			return
		}

		os.Remove(img.Filepath)
		if img.ThumbFilepath != "" && img.ThumbFilepath != img.Filepath {
			os.Remove(img.ThumbFilepath)
		}
		idx.Delete(fileID)
		log.Printf("[INFO] Deleted file: %s", fileID)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "message": "File deleted"})
	}
}

func handleHealth(idx *ImageIndex, ffmpegStatus string) http.HandlerFunc {
	startTime := time.Now()
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		imageCount := idx.Count()
		uptime := time.Since(startTime).String()

		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "healthy",
			"version":   "1.0.0",
			"uptime":    uptime,
			"ffmpeg":    ffmpegStatus,
			"images":    imageCount,
			"auth":      authMode(),
			"goVersion": runtime.Version(),
			"arch":      runtime.GOARCH,
			"os":        runtime.GOOS,
		})
	}
}

// ── ffmpeg download (system xz, available on Debian) ──

func ensureFfmpeg() string {
	// Check common locations
	candidates := []string{
		"ffmpeg/ffmpeg",
		"/usr/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
	}
	for _, p := range candidates {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			// Quick test
			cmd := exec.Command(p, "-version")
			if cmd.Run() == nil {
				log.Printf("[INFO] ffmpeg found at %s", p)
				return p
			}
		}
	}

	// Try PATH
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		log.Printf("[INFO] ffmpeg found in PATH: %s", p)
		return p
	}

	// Not found, download for ARM64
	log.Println("[INFO] Downloading ffmpeg for ARM Linux...")
	arch := runtime.GOARCH
	var dlURL string
	switch arch {
	case "arm64":
		dlURL = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
	case "arm":
		dlURL = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-armhf-static.tar.xz"
	default:
		log.Printf("[WARN]  Unsupported arch %s, ffmpeg may not be available", arch)
		return "ffmpeg"
	}

	os.MkdirAll("ffmpeg", 0755)
	tmpFile := filepath.Join(os.TempDir(), "ffmpeg.tar.xz")

	// Download
	out, err := os.Create(tmpFile)
	if err != nil {
		log.Printf("[WARN]  Cannot create tmp file: %v", err)
		return "ffmpeg"
	}
	resp, err := http.Get(dlURL)
	if err != nil {
		out.Close()
		log.Printf("[WARN]  Cannot download ffmpeg: %v", err)
		return "ffmpeg"
	}
	written, _ := io.Copy(out, resp.Body)
	out.Close()
	resp.Body.Close()
	log.Printf("   Downloaded %d bytes", written)

	// Extract using system tar (available on Debian)
	extractDir := filepath.Join(os.TempDir(), "ffmpeg_extract")
	os.RemoveAll(extractDir)
	os.MkdirAll(extractDir, 0755)

	cmd := exec.Command("tar", "-xJf", tmpFile, "-C", extractDir, "--strip-components=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		log.Printf("[WARN]  Extraction failed: %s: %v", string(output), err)
		os.Remove(tmpFile)
		return "ffmpeg"
	}
	os.Remove(tmpFile)

	// Find the ffmpeg binary (with --strip-components=1, it's directly in extractDir)
	var found string
	ffmpegSrc := filepath.Join(extractDir, "ffmpeg")
	target := filepath.Join("ffmpeg", "ffmpeg")

	if _, err := os.Stat(ffmpegSrc); err == nil {
		// Use cp instead of os.Rename (handles cross-filesystem: tmpfs → disk)
		copyCmd := exec.Command("cp", ffmpegSrc, target)
		if output, err := copyCmd.CombinedOutput(); err != nil {
			log.Printf("[WARN]  Failed to copy ffmpeg: %s: %v", string(output), err)
		} else {
			os.Chmod(target, 0755)
			// Verify with -version
			verifyCmd := exec.Command(target, "-version")
			if verifyOutput, err := verifyCmd.Output(); err == nil {
				log.Printf("[INFO] ffmpeg ready: %s", strings.Split(string(verifyOutput), "\n")[0])
				found = target
			} else {
				log.Printf("[WARN]  ffmpeg verify failed: %v", err)
			}
		}
	} else {
		// Fallback: walk for different archive structures
		log.Printf("[WARN]  ffmpeg not at expected path, searching...")
		filepath.Walk(extractDir, func(path string, info os.FileInfo, err error) error {
			if err == nil && !info.IsDir() && info.Name() == "ffmpeg" {
				if copyErr := exec.Command("cp", path, target).Run(); copyErr == nil {
					os.Chmod(target, 0755)
					found = target
				}
			}
			return nil
		})
	}
	os.RemoveAll(extractDir)

	if found == "" {
		log.Printf("[WARN]  ffmpeg binary not found or copy failed")
		return "ffmpeg"
	}
	return found
}

// ── Helpers ──

// assetPrefix devuelve el prefijo de path usado en la petición actual.
// Reconoce /cdn y /cdn2 (y variaciones sin slash inicial) y devuelve el
// prefijo coherente con el que el frontend puede construir la URL del asset.
func assetPrefix(r *http.Request) string {
	if r == nil {
		return cdnAssetPrefix
	}
	p := r.URL.Path
	// Normalizar: aceptar tanto /cdn/files/... como /cdn2/files/...
	if strings.HasPrefix(p, "/"+cdnAltAssetPrefix+"/") || strings.HasPrefix(p, "/"+cdnAltAssetPrefix) {
		if cdnAltAssetPrefix != "" {
			return cdnAltAssetPrefix
		}
	}
	if strings.HasPrefix(p, "/"+cdnAssetPrefix+"/") || strings.HasPrefix(p, "/"+cdnAssetPrefix) {
		return cdnAssetPrefix
	}
	return cdnAssetPrefix
}

func safeStr(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}

// ── Simple file copy ──
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

// ── Dedup lookup: find existing image by userId + type + sha256 ──
func findExisting(idx *ImageIndex, userID, imgType, sha string) *ImageRecord {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	for _, img := range idx.Images {
		if img.UserID == userID && img.Type == imgType && img.Sha256 == sha && img.Sha256 != "" {
			return img
		}
	}
	return nil
}

// ── CORS middleware ──
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ════════════════════════════════════════════════════════════
// Seguridad: verificación JWT (Supabase), rate limiting, límite de
// subidas concurrentes y validación de contenido real.
// ════════════════════════════════════════════════════════════
var (
	jwtSecret     string
	jwtKeyRing    atomic.Value // map[string]*ecdsa.PublicKey — claves ES256 por kid (rotación)
	allowInsecure bool
	uploadSem     chan struct{} // límite de subidas concurrentes
)

// defaultJWKSURL es el well-known de Supabase del proyecto (signing key ECC →
// tokens ES256).
const defaultJWKSURL = ""

// authConfigured
func authConfigured() bool {
	ring, _ := jwtKeyRing.Load().(map[string]*ecdsa.PublicKey)
	return jwtSecret != "" || len(ring) > 0
}

type ctxUserKey struct{}

func userFromCtx(r *http.Request) string {
	v, _ := r.Context().Value(ctxUserKey{}).(string)
	return v
}

func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) > len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}

// verifyJWT valida un access_token de Supabase (HS256) usando SOLO la stdlib:
// algoritmo, firma HMAC-SHA256, expiración. Devuelve el sub (user_id).
func verifyJWT(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("formato de token inválido")
	}

	// Header: leer el algoritmo
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", err
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if json.Unmarshal(headerRaw, &hdr) != nil {
		return "", errors.New("header inválido")
	}

	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	signingInput := []byte(parts[0] + "." + parts[1])

	switch hdr.Alg {
	case "HS256":
		// Firma HMAC-SHA256 con el JWT secret (comparación en tiempo constante)
		if jwtSecret == "" {
			return "", errors.New("secret HS256 no configurado")
		}
		mac := hmac.New(sha256.New, []byte(jwtSecret))
		mac.Write(signingInput)
		if !hmac.Equal(sig, mac.Sum(nil)) {
			return "", errors.New("firma inválida")
		}
	case "ES256":
		// Firma ECDSA P-256 con la clave pública del JWKS. Se hace match por
		// kid (rotación de claves de Supabase) con fallback a la única clave
		// disponible para tokens sin kid o PEM (backward compat).
		ring, _ := jwtKeyRing.Load().(map[string]*ecdsa.PublicKey)
		if len(ring) == 0 {
			return "", errors.New("clave pública ES256 no configurada")
		}
		pub := ring[hdr.Kid]
		if pub == nil && len(ring) == 1 {
			for _, k := range ring {
				pub = k
			}
		}
		if pub == nil {
			return "", fmt.Errorf("kid %q no está en el JWKS", hdr.Kid)
		}
		digest := sha256.Sum256(signingInput)
		// Supabase (gotrue vía go-jose) firma ES256 con la firma ECDSA en
		// formato CRUDO R||S (64 bytes), NO DER. Otras librerías (Node, etc.)
		// producen DER. Se aceptan ambos formatos para no rechazar tokens reales.
		valid := false
		if len(sig) == 64 {
			// Raw R||S: primeros 32 bytes = R, últimos 32 = S
			r := new(big.Int).SetBytes(sig[:32])
			s := new(big.Int).SetBytes(sig[32:])
			valid = ecdsa.Verify(pub, digest[:], r, s)
		}
		if !valid {
			valid = ecdsa.VerifyASN1(pub, digest[:], sig)
		}
		if !valid {
			return "", errors.New("firma inválida")
		}
	default:
		return "", errors.New("algoritmo no soportado")
	}

	// Payload: exp + sub
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	var claims map[string]interface{}
	if json.Unmarshal(payloadRaw, &claims) != nil {
		return "", errors.New("payload inválido")
	}
	exp, ok := claims["exp"].(float64)
	if !ok {
		return "", errors.New("token sin expiración")
	}
	if float64(time.Now().Unix()) >= exp {
		return "", errors.New("token expirado")
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return "", errors.New("token sin sub")
	}
	// Solo tokens de usuarios autenticados en endpoints de escritura: la anon
	// key de Supabase también está firmada con el mismo secret y role=anon.
	role, _ := claims["role"].(string)
	if role == "" || role == "anon" {
		return "", errors.New("rol no permitido")
	}
	return sub, nil
}

// requireAuth protege los endpoints de escritura (upload/delete) y aplica un
// rate limit POR USUARIO (además del por IP, que corre antes en la cadena).
func requireAuth(userLimiter *rateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allowInsecure {
			next(w, r)
			return
		}
		if !authConfigured() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "server_not_configured"})
			return
		}
		token := bearerToken(r.Header.Get("Authorization"))
		if token == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "auth_required"})
			return
		}
		sub, err := verifyJWT(token)
		if err != nil {
			log.Printf("[WARN] Rechazado (auth): %v", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			// El reason es la misma info que ya se loguea; sirve para que el
			// cliente pueda diagnosticar (token expirado, kid rotado…).
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "unauthorized", "reason": err.Error()})
			return
		}
		// Rate limit por usuario (el por IP ya se consumió en rateLimit)
		if userLimiter != nil {
			if ok, retry := userLimiter.Allow(sub); !ok {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"success": false, "error": "rate_limited", "retry_after": retry,
				})
				return
			}
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxUserKey{}, sub)))
	}
}

// ── Rate limiting (token bucket por IP [+ usuario autenticado]) ──
type rateBucket struct {
	tokens float64
	last   time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*rateBucket
	limit   float64 // tokens por minuto
}

func newRateLimiter(perMinute int) *rateLimiter {
	rl := &rateLimiter{buckets: make(map[string]*rateBucket), limit: float64(perMinute)}
	// Limpieza periódica de buckets inactivos (evita crecimiento infinito)
	go func() {
		for range time.Tick(10 * time.Minute) {
			rl.mu.Lock()
			cutoff := time.Now().Add(-10 * time.Minute)
			for k, b := range rl.buckets {
				if b.last.Before(cutoff) {
					delete(rl.buckets, k)
				}
			}
			rl.mu.Unlock()
		}
	}()
	return rl
}

// Allow consume un token del bucket. Si no hay, devuelve también los segundos
// que faltan para poder reintentar (para el header Retry-After y el contador
// del cliente).
func (rl *rateLimiter) Allow(key string) (bool, int) {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[key]
	if !ok {
		b = &rateBucket{tokens: rl.limit, last: now}
		rl.buckets[key] = b
	}
	// Refill continuo: limit tokens por minuto (tope = capacidad del bucket)
	b.tokens = math.Min(rl.limit, b.tokens+now.Sub(b.last).Seconds()*(rl.limit/60.0))
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	retry := 1
	if rl.limit > 0 {
		retry = int(math.Ceil((1 - b.tokens) / (rl.limit / 60.0)))
	}
	if retry < 1 {
		retry = 1
	}
	return false, retry
}

// clientIP: detrás de un único proxy confiable (Vercel), el ÚLTIMO salto de
// X-Forwarded-For es el que añade el proxy al conectar con nosotros → el
// cliente NO puede spoofearlo. Usar el primero sería un bypass del rate limit.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if ip := strings.TrimSpace(parts[i]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func rateLimit(rl *rateLimiter) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			key := clientIP(r)
			if sub := userFromCtx(r); sub != "" {
				key += "|" + sub
			}
			if ok, retry := rl.Allow(key); !ok {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"success": false, "error": "rate_limited", "retry_after": retry,
				})
				return
			}
			next(w, r)
		}
	}
}

// ── Validación de contenido: sniff de magic bytes ──
func sniffImageType(head []byte) string {
	if len(head) >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF {
		return "image/jpeg"
	}
	if len(head) >= 8 && bytes.Equal(head[:8], []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		return "image/png"
	}
	if len(head) >= 6 && (bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a"))) {
		return "image/gif"
	}
	if len(head) >= 12 && bytes.Equal(head[:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	return ""
}

func authMode() string {
	if allowInsecure {
		return "insecure"
	}
	if !authConfigured() {
		return "disabled"
	}
	ring, _ := jwtKeyRing.Load().(map[string]*ecdsa.PublicKey)
	if jwtSecret != "" && len(ring) > 0 {
		return "jwt-hs256+es256"
	}
	if len(ring) > 0 {
		return "jwt-es256"
	}
	return "jwt-hs256"
}

// parseECPublicKeyPEM: PEM con clave pública EC (formato PUBLIC KEY / PKIX o
// CERTIFICATE) → *ecdsa.PublicKey.
func parseECPublicKeyPEM(pemStr string) (*ecdsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("PEM inválido")
	}
	if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
		if pub, ok := cert.PublicKey.(*ecdsa.PublicKey); ok {
			return pub, nil
		}
		return nil, errors.New("el certificado no es EC")
	}
	if key, err := x509.ParsePKIXPublicKey(block.Bytes); err == nil {
		if pub, ok := key.(*ecdsa.PublicKey); ok {
			return pub, nil
		}
		return nil, errors.New("la clave no es EC")
	}
	return nil, errors.New("formato de clave no soportado")
}

// ── JWKS: obtiene la clave pública ES256 desde el well-known de Supabase ──
type jwksResponse struct {
	Keys []struct {
		Kid string `json:"kid"`
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
	} `json:"keys"`
}

// fetchJWKSKeys: descarga el well-known de Supabase y devuelve TODAS las
// claves EC P-256 indexadas por kid. Supabase mantiene la key actual y la
// anterior durante la rotación; verificar por kid hace que los tokens de
// sesiones creadas con la key anterior sigan validando en esa ventana.
func fetchJWKSKeys(jwksURL string) (map[string]*ecdsa.PublicKey, error) {
	req, err := http.NewRequest(http.MethodGet, jwksURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("JWKS HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var jwks jwksResponse
	if json.Unmarshal(body, &jwks) != nil {
		return nil, errors.New("JWKS inválido")
	}
	ring := make(map[string]*ecdsa.PublicKey)
	for _, k := range jwks.Keys {
		if k.Kty != "EC" || (k.Crv != "P-256" && k.Crv != "P256") {
			continue
		}
		xb, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil {
			continue
		}
		yb, err := base64.RawURLEncoding.DecodeString(k.Y)
		if err != nil {
			continue
		}
		pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(xb), Y: new(big.Int).SetBytes(yb)}
		ring[k.Kid] = pub
	}
	if len(ring) == 0 {
		return nil, errors.New("no hay clave EC P-256 en el JWKS")
	}
	return ring, nil
}

// ── Main ──

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("[INFO] FastChange CDN Server starting...")

	port := getEnv("PORT", "24587")
	uploadDir := getEnv("UPLOAD_DIR", "uploads")

	// ── Seguridad: config ──
	jwtSecret = os.Getenv("SUPABASE_JWT_SECRET")
	allowInsecure = os.Getenv("CDN_ALLOW_INSECURE") == "1"

	if pemStr := os.Getenv("SUPABASE_JWT_PUBLIC_KEY"); pemStr != "" {
		if k, err := parseECPublicKeyPEM(pemStr); err == nil {
			jwtKeyRing.Store(map[string]*ecdsa.PublicKey{"pem": k})
			log.Println("[INFO] Clave pública ES256 cargada (SUPABASE_JWT_PUBLIC_KEY)")
		} else {
			log.Printf("[WARN]  SUPABASE_JWT_PUBLIC_KEY inválida: %v", err)
		}
	}
	// URL del JWKS: usa el default en código si no hay env var.
	jwksURL := getEnv("SUPABASE_JWT_JWKS_URL", defaultJWKSURL)
	if ring, err := fetchJWKSKeys(jwksURL); err == nil {
		jwtKeyRing.Store(ring)
		kids := make([]string, 0, len(ring))
		for k := range ring {
			kids = append(kids, k)
		}
		slices.Sort(kids)
		log.Printf("[INFO] Claves ES256 cargadas desde JWKS (%d: %s)", len(kids), strings.Join(kids, ", "))
	} else {
		log.Printf("[WARN]  No se pudo cargar el JWKS: %v → reintentando cada 12h (503 fail-closed mientras tanto)", err)
	}
	// Rotación/self-heal: refresco periódico del keyring. Corre siempre para recuperarse solo si el JWKS estaba caído al arrancar.
	go func() {
		for range time.Tick(12 * time.Hour) {
			if ring2, err := fetchJWKSKeys(jwksURL); err == nil {
				jwtKeyRing.Store(ring2)
				kids := make([]string, 0, len(ring2))
				for k := range ring2 {
					kids = append(kids, k)
				}
				slices.Sort(kids)
				log.Printf("🔁 JWKS refrescado (%d keys: %s)", len(kids), strings.Join(kids, ", "))
			} else {
				log.Printf("[WARN]  JWKS refresh falló: %v", err)
			}
		}
	}()

	uploadRate := getEnvInt("CDN_RATE_UPLOAD", 20)
	serveRate := getEnvInt("CDN_RATE_SERVE", 600)
	maxUploads := getEnvInt("CDN_MAX_UPLOADS", 4)
	uploadSem = make(chan struct{}, maxUploads)
	if allowInsecure {
		log.Println("[WARN]  CDN_ALLOW_INSECURE=1 → auth JWT DESHABILITADA (solo desarrollo)")
	} else if !authConfigured() {
		log.Println("[WARN]  Sin credenciales JWT (secret ni clave pública/JWKS) → upload/delete responderán 503 (fail-closed)")
	} else {
		log.Printf("[INFO] Auth JWT habilitada (%s)", authMode())
	}
	log.Printf("   Rate limits: upload/delete %d/min por IP · serve %d/min por IP · máx %d subidas concurrentes", uploadRate, serveRate, maxUploads)

	os.MkdirAll(filepath.Join(uploadDir, "images"), 0755)
	os.MkdirAll(filepath.Join(uploadDir, "tmp"), 0755)

	// Initialize JSON image index
	indexPath := filepath.Join(uploadDir, "_index.json")
	idx := NewImageIndex(indexPath)
	log.Printf("[INFO] Image index loaded (%d images)", idx.Count())

	// Ensure ffmpeg
	ffmpegPath := ensureFfmpeg()
	ffmpegStatus := "ok"
	if _, err := os.Stat(ffmpegPath); os.IsNotExist(err) {
		ffmpegStatus = "not_found"
	}

	// Routes
	uploadLimiter := newRateLimiter(uploadRate)
	userLimiter := newRateLimiter(uploadRate)
	serveLimiter := newRateLimiter(serveRate)

	// Cuotas por usuario y tipo de media (tamaño y subidas/minuto).
	uploadTypeLimiters = make(map[string]*rateLimiter, len(uploadTypeRates))
	for t, perMinute := range uploadTypeRates {
		uploadTypeLimiters[t] = newRateLimiter(perMinute)
	}
	log.Printf("   Límites de media: avatar %dMB/%dmin · banner %dMB/%dmin · post %dMB/%dmin · chat %dMB/%dmin · video: solo por URL",
		uploadTypeLimits["avatar"]/(1<<20), uploadTypeRates["avatar"],
		uploadTypeLimits["banner"]/(1<<20), uploadTypeRates["banner"],
		uploadTypeLimits["post"]/(1<<20), uploadTypeRates["post"],
		uploadTypeLimits["chat"]/(1<<20), uploadTypeRates["chat"],
	)

	mux := http.NewServeMux()

	// Este servidor puede servir ambos prefijos de asset indistintamente.
	// El mismo handler procesa /cdn/... y /cdn2/... y devuelve la URL pública
	// con el prefijo desde el que llegó la petición.
	mux.HandleFunc("POST /cdn/upload", rateLimit(uploadLimiter)(requireAuth(userLimiter, handleUpload(idx))))
	mux.HandleFunc("POST /cdn2/upload", rateLimit(uploadLimiter)(requireAuth(userLimiter, handleUpload(idx))))
	mux.HandleFunc("GET /cdn/files/{id}/thumb", rateLimit(serveLimiter)(handleServeThumb(idx)))
	mux.HandleFunc("GET /cdn2/files/{id}/thumb", rateLimit(serveLimiter)(handleServeThumb(idx)))
	mux.HandleFunc("GET /cdn/files/{id}", rateLimit(serveLimiter)(handleServe(idx)))
	mux.HandleFunc("GET /cdn2/files/{id}", rateLimit(serveLimiter)(handleServe(idx)))
	mux.HandleFunc("DELETE /cdn/files/{id}", rateLimit(uploadLimiter)(requireAuth(userLimiter, handleDelete(idx))))
	mux.HandleFunc("DELETE /cdn2/files/{id}", rateLimit(uploadLimiter)(requireAuth(userLimiter, handleDelete(idx))))
	mux.HandleFunc("GET /cdn/health", handleHealth(idx, ffmpegStatus))
	mux.HandleFunc("GET /cdn2/health", handleHealth(idx, ffmpegStatus))

	handler := corsMiddleware(mux)

	log.Printf("[INFO] CDN Server listening on :%s", port)
	log.Printf("   Upload dir: %s", uploadDir)
	log.Printf("   Architecture: %s/%s", runtime.GOOS, runtime.GOARCH)

	server := &http.Server{
		Addr:           ":" + port,
		Handler:        handler,
		ReadTimeout:    30 * time.Second,
		WriteTimeout:   30 * time.Second,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 10 << 20,
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("[ERROR] Server error: %v", err)
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 {
			return n
		}
	}
	return fallback
}
