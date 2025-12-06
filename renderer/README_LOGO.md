# Assets Directory

This directory contains application assets including icons and logos.

## Required Files

1. **icon.png** - Application icon (512x512px recommended)
   - Used as the app icon in the taskbar/dock
   - Should be a PNG file
   - Electron-builder will automatically create platform-specific icon formats

2. **logo.png** - Logo image for the header
   - Used in the application header
   - Recommended size: 32x32px to 64x64px
   - Should be a PNG file with transparency support

## Adding Your Logo

1. Place your logo image as `logo.png` in the `renderer/` directory
2. Place your app icon as `icon.png` in this `assets/` directory
3. The icon should be at least 512x512px for best quality
4. For macOS, you can also provide an `.icns` file for better quality

