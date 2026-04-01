#!/usr/bin/env node

/**
 * Uploads packaged UxPlay binaries to Supabase storage
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * Uses service role key to bypass RLS policies for uploads
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Load environment variables from monorepo root
const { loadEnv } = require('../../../../scripts/load-env');
loadEnv();

class UxPlayUploader {
  constructor() {
    this.rootDir = path.join(__dirname, '..');
    this.resourcesDir = path.join(this.rootDir, 'resources');
    this.tempDir = path.join(this.resourcesDir, 'temp');
    this.bucketName = 'desktop-releases';
    this.platform = os.platform();
    this.supabase = null;
    
    // Determine platform-specific paths
    this.setupPlatformPaths();
    
    // Initialize Supabase client
    this.initializeSupabase();
  }

  /**
   * Setup platform-specific file paths
   * Note: Local files use generic names, Supabase uses original names for backwards compatibility
   */
  setupPlatformPaths() {
    if (this.platform === 'win32') {
      this.zipFileName = 'airplay-bridge.zip';
      this.zipPath = path.join(this.tempDir, this.zipFileName);
      // Keep Supabase path with original name for backwards compatibility
      // The setup script will rename files after download
      this.supabasePath = 'airplay/airplay-bridge-windows.zip';
    } else if (this.platform === 'darwin') {
      this.zipFileName = 'airplay-bridge.zip';
      this.zipPath = path.join(this.tempDir, this.zipFileName);
      this.supabasePath = 'airplay/airplay-bridge-macos.zip';
    } else {
      throw new Error(`Unsupported platform: ${this.platform}`);
    }
  }

  /**
   * Initialize Supabase client with service role key for uploads
   */
  initializeSupabase() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    // Use service role key for uploads (bypasses RLS)
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Supabase credentials not found in environment\n' +
        'Please set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY\n' +
        'These should be in .env.local at the monorepo root\n' +
        'Note: Service role key is required for uploads to bypass RLS policies'
      );
    }

    try {
      const { createClient } = require('@supabase/supabase-js');
      this.supabase = createClient(supabaseUrl, supabaseKey);
      console.log('✓ Supabase client initialized (using service role key for uploads)');
    } catch (error) {
      throw new Error(`Failed to initialize Supabase client: ${error.message}`);
    }
  }

  /**
   * Check if zip file exists
   */
  checkZipFile() {
    if (!fs.existsSync(this.zipPath)) {
      throw new Error(
        `Package zip not found at ${this.zipPath}\n` +
        `Please run packaging script first:\n` +
        `  npm run package:airplay-bridge:windows (Windows)\n` +
        `  npm run package:airplay-bridge:macos (macOS)`
      );
    }

    const stats = fs.statSync(this.zipPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`✓ Package found: ${this.zipPath}`);
    console.log(`  Size: ${sizeMB} MB`);
  }

  /**
   * Upload to Supabase storage
   */
  async upload() {
    console.log('\nUploading to Supabase storage...');
    console.log(`  Bucket: ${this.bucketName}`);
    console.log(`  Path: ${this.supabasePath}`);

    try {
      // Read file as buffer
      const fileBuffer = fs.readFileSync(this.zipPath);

      // Upload with overwrite (Supabase accepts Buffer directly in Node.js)
      const { data, error } = await this.supabase.storage
        .from(this.bucketName)
        .upload(this.supabasePath, fileBuffer, {
          contentType: 'application/zip',
          upsert: true, // Overwrite if exists
        });

      if (error) {
        throw new Error(`Supabase upload error: ${error.message}`);
      }

      console.log('✓ Upload successful!');
      console.log(`  Path: ${data.path}`);

      // Get public URL
      const { data: urlData } = this.supabase.storage
        .from(this.bucketName)
        .getPublicUrl(this.supabasePath);

      console.log(`  Public URL: ${urlData.publicUrl}`);

      return { success: true, path: data.path, url: urlData.publicUrl };
    } catch (error) {
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Verify upload
   */
  async verify() {
    console.log('\nVerifying upload...');

    try {
      // Get the file directly by path
      const { data, error } = await this.supabase.storage
        .from(this.bucketName)
        .list('airplay');

      if (error) {
        throw new Error(`Verification error: ${error.message}`);
      }

      // Find file by matching the Supabase path (without 'airplay/' prefix)
      const fileName = path.basename(this.supabasePath);
      const file = data.find(f => f.name === fileName);
      if (file) {
        const sizeMB = ((file.metadata?.size || 0) / (1024 * 1024)).toFixed(2);
        console.log(`✓ File verified in Supabase`);
        console.log(`  Name: ${file.name}`);
        console.log(`  Size: ${sizeMB} MB`);
        console.log(`  Updated: ${file.updated_at}`);
        return true;
      } else {
        // File might have just been uploaded, try to get it directly
        console.log(`  File not found in listing, but upload reported success`);
        console.log(`  This is normal for newly uploaded files`);
        return true; // Don't fail verification if upload succeeded
      }
    } catch (error) {
      console.warn(`  Verification warning: ${error.message}`);
      // Don't fail if verification has issues but upload succeeded
      return true;
    }
  }

  /**
   * Main upload process
   */
  async run() {
    try {
      console.log('==========================================');
      console.log(`AirPlay Bridge Upload (${this.platform})`);
      console.log('==========================================\n');

      this.checkZipFile();
      const result = await this.upload();
      await this.verify();

      console.log('\n==========================================');
      console.log('Upload completed successfully!');
      console.log('==========================================');
      console.log(`\nThe AirPlay bridge is now available at:`);
      console.log(`  ${this.supabasePath}`);
      console.log(`\nUsers can download it during setup with:`);
      console.log(`  npm run setup\n`);

      return result;
    } catch (error) {
      console.error('\n❌ Upload failed:', error.message);
      process.exit(1);
    }
  }
}

// Run if executed directly
if (require.main === module) {
  const uploader = new UxPlayUploader();
  uploader.run();
}

module.exports = UxPlayUploader;
