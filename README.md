# Clever Printing Agent

An Electron-based local printing agent/spooler designed for tournament management systems. This application acts as a print queue manager that receives print jobs via REST API and processes them locally.

## Features

- 🖨️ **Print Spooler**: Queue and manage print jobs with priority support
- 🔄 **Automatic Retry**: Configurable retry mechanism for failed print jobs
- 🌐 **REST API**: HTTP API for submitting print jobs from tournament management systems
- 📊 **Real-time Monitoring**: Live UI showing queue status and job progress
- ⚙️ **Printer Management**: Select and configure default printers
- 🎯 **Priority Queue**: Support for high, normal, and low priority jobs
- 📝 **Job History**: Track job status, errors, and retry attempts

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd CleverPrintingAgent
```

2. Install dependencies:
```bash
npm install
```

3. Start the application:
```bash
npm start
```

For development mode with DevTools:
```bash
npm run dev
```

## Usage

### Starting the Application

Run `npm start` to launch the Electron application. The application will:
- Start a local API server (default port: 3001)
- Open a GUI window for monitoring print jobs
- Begin processing print jobs from the queue

### Submitting Print Jobs via API

The application exposes a REST API endpoint for submitting print jobs. **PDF files are the primary method** for printing, but HTML content is also supported.

**Endpoint:** `POST http://localhost:3001/api/print`

#### Printing PDF Files

**Option 1: Base64 Encoded PDF**
```json
{
  "pdfBase64": "JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9MZW5ndGg...",
  "priority": "normal",
  "copies": 1,
  "printerName": "HP LaserJet"
}
```

**Option 2: Local File Path**
```json
{
  "pdfPath": "/path/to/document.pdf",
  "priority": "high",
  "copies": 2
}
```

**Option 3: PDF URL**
```json
{
  "pdfUrl": "http://example.com/tournament-bracket.pdf",
  "priority": "normal",
  "copies": 1
}
```

**Option 4: PDF Data (alias for pdfBase64)**
```json
{
  "pdf": "JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9MZW5ndGg...",
  "priority": "normal"
}
```

#### Printing HTML Content (Legacy Support)

**HTML Content:**
```json
{
  "html": "<h1>Tournament Bracket</h1><p>Round 1</p>",
  "priority": "normal",
  "copies": 1,
  "printerName": "HP LaserJet",
  "printBackground": true,
  "pageSize": "A4"
}
```

**HTML URL:**
```json
{
  "url": "http://example.com/print-template",
  "priority": "high",
  "copies": 2
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "job_1234567890_abc123",
  "status": "queued",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### API Endpoints

- `GET /health` - Health check endpoint
- `POST /api/print` - Submit a print job
- `GET /api/jobs` - Get all jobs in queue
- `GET /api/jobs/:jobId` - Get specific job status
- `POST /api/jobs/:jobId/cancel` - Cancel a job
- `GET /api/status` - Get spooler status
- `GET /api/printers` - Get available printers

### Example: Submitting a Print Job

#### Printing a PDF from Base64

Using `curl`:
```bash
# Read PDF file and encode to base64, then submit
PDF_BASE64=$(base64 -i tournament-bracket.pdf)
curl -X POST http://localhost:3001/api/print \
  -H "Content-Type: application/json" \
  -d "{
    \"pdfBase64\": \"$PDF_BASE64\",
    \"priority\": \"high\",
    \"copies\": 1
  }"
```

#### Printing a PDF from File Path

```bash
curl -X POST http://localhost:3001/api/print \
  -H "Content-Type: application/json" \
  -d '{
    "pdfPath": "/path/to/tournament-bracket.pdf",
    "priority": "normal",
    "copies": 1
  }'
```

#### Using JavaScript (Node.js)

```javascript
const axios = require('axios');
const fs = require('fs');

async function printPDFJob(pdfPath) {
  try {
    // Option 1: Send PDF as base64
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfBase64 = pdfBuffer.toString('base64');
    
    const response = await axios.post('http://localhost:3001/api/print', {
      pdfBase64: pdfBase64,
      priority: 'normal',
      copies: 1,
      printerName: 'HP LaserJet'
    });
    console.log('Job submitted:', response.data);
    
    // Option 2: Send PDF file path (if accessible from agent)
    // const response = await axios.post('http://localhost:3001/api/print', {
    //   pdfPath: pdfPath,
    //   priority: 'normal',
    //   copies: 1
    // });
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

// Usage
printPDFJob('./tournament-bracket.pdf');
```

## Configuration

Configuration is stored in the user data directory and can be modified through the UI or by editing the config file directly.

**Default Configuration:**
- API Port: 3001
- Max Retries: 3
- Retry Delay: 5000ms (5 seconds)
- Max Queue Size: 100 jobs

## Job Priorities

- **high**: Processed first, before normal and low priority jobs
- **normal**: Standard priority (default)
- **low**: Processed last, after high and normal priority jobs

## Job Statuses

- **queued**: Job is waiting in the queue
- **processing**: Job is currently being printed
- **completed**: Job finished successfully
- **failed**: Job failed after all retry attempts
- **cancelled**: Job was cancelled by user

## Building for Distribution

To build the application for distribution:

```bash
# Build for current platform
npm run build

# Build for specific platforms
npm run build:win    # Windows NSIS installer (x64 and x86)
npm run build:mac    # macOS DMG file
npm run build:linux  # Linux AppImage

# Build for all platforms
npm run build:all
```

This will create platform-specific installers:
- **Windows**: NSIS installer (`.exe`) - Supports both 64-bit and 32-bit architectures
  - Allows custom installation directory
  - Creates desktop and Start Menu shortcuts
  - Located in `dist/` directory after build
- **macOS**: DMG file
- **Linux**: AppImage

### Windows Installer Features

The Windows installer includes:
- Custom installation directory selection
- Desktop shortcut creation
- Start Menu shortcut creation
- Automatic app launch after installation
- Uninstaller support

## Architecture

```
CleverPrintingAgent/
├── src/
│   ├── main.js              # Electron main process
│   ├── preload.js           # Preload script for secure IPC
│   ├── spooler/
│   │   └── PrintSpooler.js  # Print queue management
│   ├── api/
│   │   └── APIServer.js     # REST API server
│   └── config/
│       └── ConfigManager.js  # Configuration management
├── renderer/
│   ├── index.html           # UI HTML
│   ├── styles.css           # UI styles
│   └── renderer.js          # UI logic
└── package.json
```

## Integration with Tournament Management System

The printing agent is designed to be integrated with tournament management systems:

1. **Install the agent** on machines that need printing capabilities
2. **Configure the API endpoint** in your tournament management system
3. **Submit print jobs** via HTTP POST requests when printing is needed
4. **Monitor job status** through the API or the GUI

Example integration flow:
```
Tournament System → HTTP POST → Printing Agent → Local Printer
```

## Troubleshooting

### Port Already in Use
If port 3001 is already in use, the application will display an error. You can change the port in the configuration.

### Printer Not Found
Ensure the printer is properly installed and accessible on the system. Use the "Select Printer" button in the UI to choose a default printer.

### Print Jobs Failing
- Check printer connectivity
- Verify printer has paper and is not in error state
- Review error messages in the job details
- Check system print queue for additional errors

### Windows SmartScreen Warning
When running the Windows installer or executable, you may see a "Windows protected your PC" warning from Microsoft Defender SmartScreen. This is normal for unsigned applications and does not indicate a problem with the software.

**To proceed:**
1. Click "More info" in the warning dialog
2. Click "Run anyway" to continue with the installation/execution

**For production distribution:**
To avoid this warning for end users, you'll need to code sign the executable with a valid code signing certificate from a trusted Certificate Authority (CA). This requires:
- Purchasing a code signing certificate (typically $200-400/year)
- Configuring electron-builder with certificate details
- Signing during the build process

For internal/testing use, the "Run anyway" option is safe to use.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
