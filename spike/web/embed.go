// Package web embeds the spike's static PWA.
package web

import "embed"

// Static holds index.html, the scripts, the service worker, the manifest and the icons.
//
//go:embed static
var Static embed.FS
