package image

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	FfmpegBin = "ffmpeg/ffmpeg"
	quality   = 90 // WebP quality
)

// Dimensions defines target resize dimensions
type Dimensions struct {
	Width  int
	Height int
	Fit    string // "cover", "contain", "scale"
}

// Profile thumbnails by image type
var SizeMap = map[string]Dimensions{
	"avatar": {Width: 256, Height: 256, Fit: "cover"},
	"banner": {Width: 1200, Height: 440, Fit: "cover"},
	"post":   {Width: 1200, Height: 0, Fit: "scale"},   // width limit, height auto
	"chat":   {Width: 600, Height: 0, Fit: "scale"},     // width limit, height auto
}

// ProcessResult holds info about the processed image
type ProcessResult struct {
	Filepath      string
	MimeType      string
	SizeBytes     int64
	Width         int
	Height        int
}

// ProcessImage resizes and converts an image to WebP using ffmpeg
func ProcessImage(inputPath, outputDir, fileID, imgType string) (*ProcessResult, error) {
	// Ensure output directory exists
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, fmt.Errorf("mkdir output: %w", err)
	}

	outputPath := filepath.Join(outputDir, fileID+".webp")
	dims, ok := SizeMap[imgType]
	if !ok {
		dims = Dimensions{Width: 1200, Height: 0, Fit: "scale"}
	}

	// Build ffmpeg arguments
	args := []string{
		"-i", inputPath,
		"-q:v", strconv.Itoa(quality),
		"-compression_level", "6",
		"-preset", "picture",
		"-metadata:s:v", "rotate=0", // strip rotation metadata
	}

	// Add resize filter
	switch dims.Fit {
	case "cover":
		// Crop to fill exactly
		args = append(args, "-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d", dims.Width, dims.Height, dims.Width, dims.Height))
	case "scale":
		// Scale to width, keep aspect ratio
		if dims.Width > 0 {
			args = append(args, "-vf", fmt.Sprintf("scale=%d:-1", dims.Width))
		}
	default:
		// Contain within dimensions
		if dims.Width > 0 && dims.Height > 0 {
			args = append(args, "-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", dims.Width, dims.Height))
		}
	}

	args = append(args, "-y", outputPath) // -y = overwrite

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, FfmpegBin, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg error: %s: %s", string(output), err)
	}

	// Get file info
	info, err := os.Stat(outputPath)
	if err != nil {
		return nil, fmt.Errorf("stat output: %w", err)
	}

	// Get dimensions from the output file
	width, height := getDimensions(outputPath)

	result := &ProcessResult{
		Filepath:  outputPath,
		MimeType:  "image/webp",
		SizeBytes: info.Size(),
		Width:     width,
		Height:    height,
	}

		return &ProcessResult{
		Filepath:  outputPath,
		MimeType:  "image/webp",
		SizeBytes: info.Size(),
		Width:     width,
		Height:    height,
	}, nil
}

// getDimensions extracts image dimensions using ffprobe (bundled with ffmpeg)
func getDimensions(filePath string) (int, int) {
	// Try using ffprobe (bundled with ffmpeg static build)
	probeBin := filepath.Join(filepath.Dir(FfmpegBin), "ffprobe")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, probeBin,
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

// GetContentType returns the MIME type for a file extension
func GetContentType(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	default:
		return "application/octet-stream"
	}
}

// Cleanup removes the temp input file
func Cleanup(path string) {
	os.Remove(path)
}
