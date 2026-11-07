package store

import (
	"database/sql"
	"log"
	"time"

	_ "modernc.org/sqlite"
)

var db *sql.DB

// ImageRecord represents a stored image in the database
type ImageRecord struct {
	ID           string    `json:"id"`
	UserID       string    `json:"user_id"`
	Type         string    `json:"type"` // avatar, banner, post, chat
	OriginalName string    `json:"original_name,omitempty"`
	Filepath     string    `json:"filepath"`
	URL          string    `json:"url"`
	MimeType     string    `json:"mime_type"`
	SizeBytes    int64     `json:"size_bytes"`
	Width        int       `json:"width"`
	Height       int       `json:"height"`
	CreatedAt    time.Time `json:"created_at"`
}

func Init(dbPath string) error {
	var err error
	db, err = sql.Open("sqlite", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return err
	}

	db.SetMaxOpenConns(1) // SQLite only supports one writer
	db.SetMaxIdleConns(1)

	if err := migrate(); err != nil {
		return err
	}

	return nil
}

func migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS images (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		type TEXT NOT NULL CHECK(type IN ('avatar', 'banner', 'post', 'chat')),
		original_name TEXT DEFAULT '',
		filepath TEXT NOT NULL,
		url TEXT NOT NULL,
		mime_type TEXT DEFAULT 'image/webp',
		size_bytes INTEGER DEFAULT 0,
		width INTEGER DEFAULT 0,
		height INTEGER DEFAULT 0,
		created_at TEXT DEFAULT (datetime('now'))
	);

	CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id);
	CREATE INDEX IF NOT EXISTS idx_images_type ON images(type);
	CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);
	`
	_, err := db.Exec(schema)
	if err != nil {
		return err
	}

	log.Println("[INFO] Database migrated successfully")
	return nil
}

// InsertImage stores a new image record
func InsertImage(img ImageRecord) error {
	_, err := db.Exec(`
		INSERT INTO images (id, user_id, type, original_name, filepath, url, mime_type, size_bytes, width, height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, img.ID, img.UserID, img.Type, img.OriginalName, img.Filepath, img.URL, img.MimeType, img.SizeBytes, img.Width, img.Height, img.CreatedAt.Format(time.RFC3339))
	return err
}

// GetImage retrieves an image by ID
func GetImage(id string) (*ImageRecord, error) {
	row := db.QueryRow(`
		SELECT id, user_id, type, original_name, filepath, url, mime_type, size_bytes, width, height, created_at
		FROM images WHERE id = ?
	`, id)

	var img ImageRecord
	var createdAt string
	err := row.Scan(&img.ID, &img.UserID, &img.Type, &img.OriginalName, &img.Filepath, &img.URL, &img.MimeType, &img.SizeBytes, &img.Width, &img.Height, &createdAt)
	if err != nil {
		return nil, err
	}

	img.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &img, nil
}

// GetImageByURL retrieves an image by its URL path
func GetImageByURL(url string) (*ImageRecord, error) {
	row := db.QueryRow(`
		SELECT id, user_id, type, original_name, filepath, url, mime_type, size_bytes, width, height, created_at
		FROM images WHERE url = ?
	`, url)

	var img ImageRecord
	var createdAt string
	err := row.Scan(&img.ID, &img.UserID, &img.Type, &img.OriginalName, &img.Filepath, &img.URL, &img.MimeType, &img.SizeBytes, &img.Width, &img.Height, &createdAt)
	if err != nil {
		return nil, err
	}

	img.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &img, nil
}

// DeleteImage removes an image record by ID
func DeleteImage(id string) error {
	_, err := db.Exec("DELETE FROM images WHERE id = ?", id)
	return err
}

// GetUserImages retrieves all images for a user
func GetUserImages(userID string, limit, offset int) ([]ImageRecord, error) {
	rows, err := db.Query(`
		SELECT id, user_id, type, original_name, filepath, url, mime_type, size_bytes, width, height, created_at
		FROM images WHERE user_id = ?
		ORDER BY created_at DESC
		LIMIT ? OFFSET ?
	`, userID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []ImageRecord
	for rows.Next() {
		var img ImageRecord
		var createdAt string
		if err := rows.Scan(&img.ID, &img.UserID, &img.Type, &img.OriginalName, &img.Filepath, &img.URL, &img.MimeType, &img.SizeBytes, &img.Width, &img.Height, &createdAt); err != nil {
			return nil, err
		}
		img.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		images = append(images, img)
	}
	return images, nil
}

// CountImages returns the total number of images in the database
func CountImages() (int, error) {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM images").Scan(&count)
	return count, err
}

// Close closes the database connection
func Close() error {
	if db != nil {
		return db.Close()
	}
	return nil
}
