const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

let hasWinOCR = false;
let OcrEngine, BitmapDecoder, SoftwareBitmap, StorageFile, Streams, Language;
try {
    // Attempt to load Windows OCR and related imaging modules
    ({ OcrEngine } = require('@nodert-win10/windows.media.ocr'));        // Windows.Media.Ocr
    ({ BitmapDecoder, SoftwareBitmap } = require('@nodert-win10/windows.graphics.imaging'));
    ({ StorageFile, FileAccessMode } = require('@nodert-win10/windows.storage'));
    ({ InMemoryRandomAccessStream, DataWriter } = require('@nodert-win10/windows.storage.streams'));
    ({ Language } = require('@nodert-win10/windows.globalization'));
    hasWinOCR = true;
    console.log('Windows OCR modules loaded.');
} catch (error) {
    console.log('Windows OCR not available, using Tesseract fallback.');
    hasWinOCR = false;
}

// --- BEGIN: Ensure Tesseract.exe is on PATH (Windows) ---
const candidateTesseractDirs = [
  'C:\\\\Program Files\\\\Tesseract-OCR',
  'C:\\\\Program Files (x86)\\\\Tesseract-OCR',
  // common user-local install from UB Mannheim build:
  path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Tesseract-OCR')
];

function ensureTesseractOnPath() {
  if (process.platform !== 'win32') return;
  for (const dir of candidateTesseractDirs) {
    if (dir && fs.existsSync(path.join(dir, 'tesseract.exe'))) {
      // Prepend so it wins over any stale PATH entries
      process.env.PATH = `${dir};${process.env.PATH || ''}`;
      // Help tesseract find tessdata if needed
      if (!process.env.TESSDATA_PREFIX) process.env.TESSDATA_PREFIX = dir;
      console.log('[OCR] Added to PATH:', dir);
      return;
    }
  }
  console.warn('[OCR] Could not find tesseract.exe in common locations. Add its folder to PATH.');
}
ensureTesseractOnPath();
// --- END: Ensure Tesseract.exe is on PATH (Windows) ---
let tesseract;
// OCR engine support (Tesseract and Windows OCR)
let tesseractConfig, tesseractDigitsConfig;
try {
  // Try to require Tesseract OCR module
  tesseract = require('node-tesseract-ocr');
  // Default OCR config for Tesseract (general text)
const tesseractConfig = {
  lang: 'eng',
  oem: 1,
  psm: 6
};
  // Digits-only OCR config for Tesseract (numbers and symbols only)
const tesseractDigitsConfig = {
  lang: 'eng',
  oem: 1,
  psm: 6,
  tessedit_char_whitelist: '0123456789.+%'
};
} catch (e) {
  console.error('Tesseract OCR module not available:', e);
}
// Utility: perform OCR on an image using available engines
async function runOcrEngine(imagePath, digitsOnly = false) {
  let textResult = '';
  // If doing general text OCR (labels + numbers)
  if (!digitsOnly) {
    if (hasWinOCR) {
      try {
        // Use Windows built-in OCR for primary text (label) recognition
        const file = await StorageFile.getFileFromPathAsync(imagePath);
        const stream = await file.openAsync(FileAccessMode.read);
        const decoder = await BitmapDecoder.createAsync(stream);
        const bitmap = await decoder.getSoftwareBitmapAsync();
        const engine = OcrEngine.tryCreateFromLanguage(new Language('en'));
        const result = await engine.recognizeAsync(bitmap);
        textResult = result && result.text ? result.text : '';
      } catch (err) {
        console.error('Windows OCR failed, falling back to Tesseract:', err);
        textResult = '';
      }
    }
    if (!textResult && tesseract) {
      // Use Tesseract OCR as fallback (or primary if Windows OCR not used)
      try {
        textResult = await tesseract.recognize(imagePath, tesseractConfig);
      } catch (e) {
        console.error('Tesseract primary OCR error:', e);
      }
    }
  } else {
    // Digits-only OCR pass (for numeric values)
    if (tesseract) {
      try {
        textResult = await tesseract.recognize(imagePath, tesseractDigitsConfig);
      } catch (e) {
        console.error('Tesseract digits OCR error:', e);
      }
    } else {
      // No Tesseract available for digits pass
      console.warn('No Tesseract available for digits OCR pass');
      textResult = '';
    }
  }
  return textResult || '';
}

// Utility: capture screenshot of gear stats region and save to file
async function captureScreenshot() {
  // Use screenshot-desktop to capture the screen (or specific display if needed)
  let screenshot;
  try {
    screenshot = require('screenshot-desktop');
  } catch (e) {
    console.error('Screenshot module not found:', e);
    return null;
  }
  const outputPath = path.join(process.cwd(), 'last-crop.png');
  try {
    const result = await screenshot({ filename: outputPath, format: 'png' });
    // result may be the image path or an array of paths (for multiple displays)
    if (Array.isArray(result)) {
      return result[0];  // use the first screen's image path
    } else if (typeof result === 'string') {
      return result;     // image path
    } else {
      // If no explicit path returned, assume saved to outputPath
      return outputPath;
    }
  } catch (err) {
    console.error('Screen capture failed:', err);
    return null;
  }
}
ipcMain.handle('grab', async () => {
  const d = screen.getPrimaryDisplay();
  const { width, height } = d.size;
  const sf = d.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) }
  });
  return sources[0].thumbnail.toPNG();  // Returns a PNG buffer of the primary screen
});

// IPC handler: Primary OCR (capture and recognize text)
ipcMain.handle('ocr', async (event, imageBuffer) => {
    // Preprocess the image buffer using Sharp (e.g. convert to grayscale and PNG)
    const inputBuffer = Buffer.from(imageBuffer);  // ensure Node Buffer from Uint8Array
    const processedImage = await sharp(inputBuffer)
        .png()            // convert to PNG format (Sharp ensures image is decodable)
        .toBuffer();      // get the processed image data as Buffer
let text = '';
    if (hasWinOCR) {
        try {
            // Use Windows 10 OCR if available
            const engine = OcrEngine.tryCreateFromLanguage(new Language('en'));
            // Convert image Buffer to WinRT SoftwareBitmap
            const memStream = new InMemoryRandomAccessStream();
            const writer = new Streams.DataWriter(memStream);
            if (processedImage && processedImage.length > 0) {
                writer.writeBytes(new Uint8Array(processedImage));
                await writer.storeAsync();
            } else {
                throw new Error('Empty image buffer – cannot write to OCR stream');
            }
            const decoder = await BitmapDecoder.createAsync(memStream);
            const softwareBitmap = await decoder.getSoftwareBitmapAsync();
            const ocrResult = await engine.recognizeAsync(softwareBitmap);
            text = ocrResult.text;
        } catch (winErr) {
            console.warn('Windows OCR failed, falling back to Tesseract:', winErr);
            // Fallback to Tesseract OCR if any error occurs
            text = await tesseract.recognize(processedImage, { lang: 'eng' });
        }
    } else {
        // If Windows OCR not available, use Tesseract directly
        text = await tesseract.recognize(processedImage, tesseractConfig);
    }
    return text;
});

// IPC handler: Secondary OCR (digits only)
ipcMain.handle('ocr-digits', async (event, imageBuffer) => {
    // Preprocess the image buffer (same as in 'ocr')
    const inputBuffer = Buffer.from(imageBuffer);
    const processedImage = await sharp(inputBuffer).png().toBuffer();
    // Perform OCR using Tesseract with a whitelist for digits and common symbols
    const text = await tesseract.recognize(processedImage, tesseractDigitsConfig);
    return text;
});

// Create the main application window
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,       // Ensure minimum 600px width
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    alwaysOnTop: true,   // Keep overlay on top (if desired for overlay use-case)
    frame: true          // You can set to false if a frameless overlay is preferred
  });
  mainWindow.loadFile('index.html');
}

// Handle app lifecycle events
app.whenReady().then(() => {
  createWindow();
  // Global hotkey for capture (e.g. F8)
  globalShortcut.register('F8', async () => {
    try {
      const imagePath = await captureScreenshot();
      if (!imagePath) return;
      const text = await runOcrEngine(imagePath, false);
      const digitsText = await runOcrEngine(imagePath, true);
      // Save debug files
      try {
        fs.writeFileSync('last-ocr.txt', text, 'utf-8');
        fs.writeFileSync('last-ocr-digits.txt', digitsText, 'utf-8');
      } catch (e) {
        console.error('Error saving debug files in global capture:', e);
      }
      // Send OCR results to renderer for parsing and display
      if (mainWindow && text) {
        mainWindow.webContents.send('ocr-result', { text: text, digitsText: digitsText });
      } else if (mainWindow) {
        // If no text detected, still notify (could be used to hide overlay)
        mainWindow.webContents.send('ocr-result', { text: '', digitsText: '' });
      }
    } catch (err) {
      console.error('Global capture OCR failed:', err);
    }
  });
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Unregister global shortcuts on exit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Quit the app when all windows are closed (except on macOS, per convention)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
