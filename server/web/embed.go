// Package web embeds the built PWA. The image build replaces static/ with the client build
// output (web/dist); the committed static/index.html is only a placeholder for server-only
// builds and tests.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:static
var files embed.FS

// Static is the PWA's file tree.
func Static() fs.FS {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	return sub
}
