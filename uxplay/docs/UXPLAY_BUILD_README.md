# Echo iOS Bridge Packaging Note

This repository no longer owns the UxPlay, `gst-libav`, or AirPlay bridge packaging pipeline.

Current policy:
- Echo Desktop does not bundle the iOS bridge binaries.
- Echo Desktop does not download or install the bridge in-app.
- The bridge should ship from a separate open-source repository with its own license, notices, source, and release artifacts.

Keep any future build, packaging, and release documentation for that bridge in the separate companion repository.
