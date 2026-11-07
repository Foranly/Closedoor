package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"time"

	"cdn-server/image"
	"cdn-server/store"
)

type healthResponse struct {
	Status    string `json:"status"`
	Version   string `json:"version"`
	Uptime    string `json:"uptime"`
	Ffmpeg    string `json:"ffmpeg"`
	Storage   string `json:"storage"`
	Images    int    `json:"images"`
	GoVersion string `json:"go_version"`
	Arch      string `json:"arch"`
	OS        string `json:"os"`
}

var startTime = time.Now()

func Health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Check ffmpeg availability
	ffmpegStatus := "ok"
	if _, err := os.Stat(image.FfmpegBin); os.IsNotExist(err) {
		ffmpegStatus = "not_found"
	}

	// Check storage
	storageStatus := "ok"
	if _, err := os.Stat("uploads/images"); os.IsNotExist(err) {
		storageStatus = "no_uploads"
	}

	// Count images in database
	imageCount, _ := store.CountImages()

	// Get uptime
	uptime := time.Since(startTime).String()

	json.NewEncoder(w).Encode(healthResponse{
		Status:    "healthy",
		Version:   "1.0.0",
		Uptime:    uptime,
		Ffmpeg:    ffmpegStatus,
		Storage:   storageStatus,
		Images:    imageCount,
		GoVersion: runtime.Version(),
		Arch:      runtime.GOARCH,
		OS:        runtime.GOOS,
	})
}
