const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

class APIServer {
  constructor(port, printSpooler) {
    this.port = port;
    this.printSpooler = printSpooler;
    this.app = express();
    this.server = null;
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(bodyParser.json({ limit: '50mb' })); // Increased for PDF base64
    this.app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
    
    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        spooler: this.printSpooler.getStatus()
      });
    });

    // Submit print job
    this.app.post('/api/print', async (req, res) => {
      try {
        const jobData = {
          pdf: req.body.pdf, // Base64 encoded PDF or file path
          pdfBase64: req.body.pdfBase64, // Explicit base64 PDF data
          pdfPath: req.body.pdfPath, // Local file path to PDF
          pdfUrl: req.body.pdfUrl, // URL to PDF file
          html: req.body.html, // HTML content (legacy support)
          url: req.body.url, // URL to HTML page (legacy support)
          printerName: req.body.printerName,
          priority: req.body.priority || 'normal',
          printBackground: req.body.printBackground !== false,
          pageSize: req.body.pageSize || 'A4',
          margins: req.body.margins,
          copies: req.body.copies || 1,
          metadata: req.body.metadata || {}
        };

        // Validate required fields - PDF takes priority
        if (!jobData.pdf && !jobData.pdfBase64 && !jobData.pdfPath && !jobData.pdfUrl && !jobData.html && !jobData.url) {
          return res.status(400).json({ 
            error: 'Either pdf, pdfBase64, pdfPath, pdfUrl, html, or url must be provided' 
          });
        }

        const job = await this.printSpooler.addJob(jobData);
        res.json({ 
          success: true, 
          jobId: job.id,
          status: job.status,
          timestamp: job.timestamp
        });
      } catch (error) {
        console.error('Error adding print job:', error);
        res.status(500).json({ 
          error: error.message || 'Failed to add print job' 
        });
      }
    });

    // Get job status
    this.app.get('/api/jobs/:jobId', (req, res) => {
      const jobId = req.params.jobId;
      const jobs = this.printSpooler.getJobQueue();
      const job = jobs.find(j => j.id === jobId);
      
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      res.json({
        id: job.id,
        status: job.status,
        timestamp: job.timestamp,
        priority: job.priority,
        retryCount: job.retryCount,
        error: job.error
      });
    });

    // Get all jobs
    this.app.get('/api/jobs', (req, res) => {
      const jobs = this.printSpooler.getJobQueue();
      res.json({
        jobs: jobs.map(job => ({
          id: job.id,
          status: job.status,
          timestamp: job.timestamp,
          priority: job.priority,
          retryCount: job.retryCount,
          error: job.error
        }))
      });
    });

    // Get spooler status
    this.app.get('/api/status', (req, res) => {
      res.json(this.printSpooler.getStatus());
    });

    // Get available printers
    this.app.get('/api/printers', async (req, res) => {
      try {
        const printers = await this.printSpooler.getAvailablePrinters();
        res.json({ printers });
      } catch (error) {
        console.error('Error getting printers:', error);
        res.status(500).json({ error: 'Failed to get printers' });
      }
    });

    // Cancel job
    this.app.post('/api/jobs/:jobId/cancel', async (req, res) => {
      try {
        const jobId = req.params.jobId;
        const success = await this.printSpooler.cancelJob(jobId);
        
        if (success) {
          res.json({ success: true, message: 'Job cancelled' });
        } else {
          res.status(404).json({ error: 'Job not found or cannot be cancelled' });
        }
      } catch (error) {
        console.error('Error cancelling job:', error);
        res.status(500).json({ error: 'Failed to cancel job' });
      }
    });

    // Error handling
    this.app.use((err, req, res, next) => {
      console.error('API Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      console.log(`Print Spooler API server running on port ${this.port}`);
      console.log(`Health check: http://localhost:${this.port}/health`);
      console.log(`API endpoint: http://localhost:${this.port}/api/print`);
    });

    this.server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is already in use. Please choose a different port.`);
      } else {
        console.error('Server error:', error);
      }
    });
  }

  stop() {
    if (this.server) {
      this.server.close(() => {
        console.log('API server stopped');
      });
    }
  }
}

module.exports = APIServer;

