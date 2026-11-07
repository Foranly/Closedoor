package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"cdn-server/image"
	"cdn-server/store"

	"github.com/google/uuid"
)

const maxUploadSize = 20 << 20 // 20MB

type uploadResponse struct {
	Success bool   `json:"success"`
	URL     string `json:"url"`
	ID      string `json:"id"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
	SizeKB  int64  `json:"size_kb,omitempty"`
	Error   string `json:"error,omitempty"`
}

var allowedMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

func Upload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// ── Limit upload size ──
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		json.NewEncoder(w).Encode(uploadResponse{
			Success: false,
			Error:   fmt.Sprintf("File too large (max %dMB)", maxUploadSize/(1<<20)),
		})
		return
	}

	// ── Get form fields ──
	userID := r.FormValue("user_id")
	imgType := r.FormValue("type")
	if userID == "" || imgType == "" {
		json.NewEncoder(w).Encode(uploadResponse{
			Success: false,
			Error:   "Missing required fields: user_id, type",
		})
		return
	}

	// Validate image type
	validTypes := map[string]bool{"avatar": true, "banner": true, "post": true, "chat": true}
	if !validTypes[imgType] {
		json.NewEncoder(w).Encode(uploadResponse{
			Success: false,
			Error:   "Invalid type. Must be: avatar, banner, post, or chat",
		})
		return
	}

	// ── Get the uploaded file ──
	file, header, err := r.FormFile("file")
	if err != nil {
		json.NewEncoder(w).Encode(uploadResponse{
			Success: false,
			Error:   "No file provided",
		})
		return
	}
	defer file.Close()

	// Validate MIME type
	mimeType := header.Header.Get("Content-Type")
	// Also check by extension
	ext := filepath.Ext(header.Filename)
	if !allowedMimeTypes[mimeType] && !allowedMimeTypes[image.GetContentType(ext)] {
		json.NewEncoder(w).Encode(uploadResponse{
			Success: false,
			Error:   fmt.Sprintf("Unsupported file type: %s. Allowed: JPEG, PNG, GIF, WebP", mimeType),
		})
		return
	}

	// ── Save temp file ──
	tmpDir := "uploads/tmp"
	os.MkdirAll(tmpDir, 0755)

	fileID := fmt.Sprintf("%s_%s_%s", userID[:8], imgType, uuid.New().String()[:8])
	tmpPath := filepath.Join(tmpDir, fileID+ext)

	tmpFile, err := os.Create(tmpPath)
	if err != nil {
		log.Printf("Error creating temp file: %v", err)
		json.NewEncoder(w).Encode(uploadResponse{Success: false, Error: "Internal server error"})
		return
	}

	_, err = io.Copy(tmpFile, file)
	tmpFile.Close()
	if err != nil {
		os.Remove(tmpPath)
		log.Printf("Error saving temp file: %v", err)
		json.NewEncoder(w).Encode(uploadResponse{Success: false, Error: "Failed to save file"})
		return
	}
	defer os.Remove(tmpPath) // Clean up temp file after processing

	// ── Process image with ffmpeg (resize + WebP) ──
	uploadDir := "uploads/images"
	result, err := image.ProcessImage(tmpPath, uploadDir, fileID, imgType)
	if err != nil {
		log.Printf("Error processing image: %v", err)
		json.NewEncoder(w).Encode(uploadResponse{
			Success: false,
			Error:   fmt.Sprintf("Image processing failed: %v", err),
		})
		return
	}

	// ── Build public URL ──
	baseURL := r.Header.Get("X-Forwarded-Host")
	if baseURL == "" {
		baseURL = r.Host
	}
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	publicURL := fmt.Sprintf("%s://%s/cdn/files/%s", scheme, baseURL, fileID)

	// ── Store in database ──
	imgRecord := store.ImageRecord{
		ID:           fileID,
		UserID:       userID,
		Type:         imgType,
		OriginalName: header.Filename,
		Filepath:     result.Filepath,
		URL:          publicURL,
		MimeType:     result.MimeType,
		SizeBytes:    result.SizeBytes,
		Width:        result.Width,
		Height:       result.Height,
		CreatedAt:    time.Now(),
	}

	if err := store.InsertImage(imgRecord); err != nil {
		log.Printf("Error storing in database: %v", err)
		// File is already processed, just log the error
	}

	log.Printf("[INFO] Uploaded %s: %s (%s, %dx%d, %dKB)", imgType, fileID, result.MimeType, result.Width, result.Height, result.SizeBytes/1024)

	// ── Response ──
	json.NewEncoder(w).Encode(uploadResponse{
		Success: true,
		URL:     publicURL,
		ID:      fileID,
		Width:   result.Width,
		Height:  result.Height,
		SizeKB:  result.SizeBytes / 1024,
	})
}

