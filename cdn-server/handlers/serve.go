package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"cdn-server/store"
)

func ServeFile(w http.ResponseWriter, r *http.Request) {
	fileID := r.PathValue("id")
	if fileID == "" {
		http.Error(w, "Missing file ID", http.StatusBadRequest)
		return
	}

	// Find in database
	img, err := store.GetImage(fileID)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Check file exists on disk
	if _, err := os.Stat(img.Filepath); os.IsNotExist(err) {
		// File missing from disk but record exists - attempt cleanup
		store.DeleteImage(fileID)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Serve the file
	w.Header().Set("Content-Type", img.MimeType)
	// Sin caché: el navegador/proxy debe re-solicitar la imagen siempre
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	http.ServeFile(w, r, img.Filepath)
}

func DeleteFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	fileID := r.PathValue("id")
	if fileID == "" {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Missing file ID",
		})
		return
	}

	// Find in database
	img, err := store.GetImage(fileID)
	if err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "File not found",
		})
		return
	}

	// Delete from disk
	if err := os.Remove(img.Filepath); err != nil && !os.IsNotExist(err) {
		log.Printf("Error deleting file %s: %v", fileID, err)
	}

	// Delete from database
	if err := store.DeleteImage(fileID); err != nil {
		log.Printf("Error deleting database record %s: %v", fileID, err)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Failed to delete record",
		})
		return
	}

	log.Printf("[INFO] Deleted file: %s", fileID)

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File deleted",
	})
}
