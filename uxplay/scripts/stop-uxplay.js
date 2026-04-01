#!/usr/bin/env node

/**
 * Stop UxPlay server script
 * Finds and stops all running UxPlay processes
 */

const { execSync } = require('child_process');
const os = require('os');

function stopUxPlay() {
  console.log('==========================================');
  console.log('Stopping UxPlay Server');
  console.log('==========================================\n');

  try {
    if (os.platform() === 'win32') {
      // Windows: Use taskkill
      try {
        const output = execSync('tasklist /FI "IMAGENAME eq uxplay.exe" /FO CSV /NH', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (output.trim() && output.includes('uxplay.exe')) {
          console.log('Found running UxPlay processes, stopping...');
          try {
            execSync('taskkill /F /IM uxplay.exe', {
              stdio: 'pipe',
            });
            console.log('✓ UxPlay stopped successfully');
          } catch (killError) {
            // Process might have exited between check and kill
            if (killError.message.includes('not found')) {
              console.log('No UxPlay processes found (already stopped)');
            } else {
              throw killError;
            }
          }
        } else {
          console.log('No UxPlay processes found');
        }
      } catch (error) {
        // tasklist returns non-zero when no processes found
        if (error.status === 1 || error.message.includes('not found')) {
          console.log('No UxPlay processes found');
        } else {
          throw error;
        }
      }
    } else {
      // Unix-like: Use pkill or killall
      try {
        execSync('pkill -f uxplay', {
          stdio: 'inherit',
        });
        console.log('✓ UxPlay stopped successfully');
      } catch (error) {
        if (error.status === 1) {
          console.log('No UxPlay processes found');
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    console.error(`❌ Error stopping UxPlay: ${error.message}`);
    process.exit(1);
  }
}

stopUxPlay();

