/**
 * Example script to test the Clever Printing Agent API
 * 
 * Usage: node examples/test-print.js
 * 
 * Make sure the Electron app is running before executing this script.
 */

const http = require('http');

const API_BASE = 'http://localhost:3001';

// Test HTML content
const testHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Test Print Job</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            padding: 20px;
        }
        h1 {
            color: #333;
        }
        .info {
            background: #f0f0f0;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <h1>Tournament Management System</h1>
    <div class="info">
        <p><strong>Test Print Job</strong></p>
        <p>Timestamp: ${new Date().toISOString()}</p>
        <p>This is a test print job from the Clever Printing Agent.</p>
    </div>
    <p>If you can see this, the printing agent is working correctly!</p>
</body>
</html>
`;

function makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3001,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

async function testAPI() {
    console.log('🧪 Testing Clever Printing Agent API\n');

    try {
        // Test 1: Health check
        console.log('1. Testing health endpoint...');
        const health = await makeRequest('GET', '/health');
        console.log('   Status:', health.status);
        console.log('   Response:', JSON.stringify(health.data, null, 2));
        console.log('');

        // Test 2: Get available printers
        console.log('2. Getting available printers...');
        const printers = await makeRequest('GET', '/api/printers');
        console.log('   Status:', printers.status);
        console.log('   Printers:', JSON.stringify(printers.data, null, 2));
        console.log('');

        // Test 3: Submit a print job
        console.log('3. Submitting a test print job...');
        const printJob = await makeRequest('POST', '/api/print', {
            html: testHTML,
            priority: 'normal',
            copies: 1,
            printBackground: true
        });
        console.log('   Status:', printJob.status);
        console.log('   Response:', JSON.stringify(printJob.data, null, 2));
        console.log('');

        if (printJob.data.jobId) {
            const jobId = printJob.data.jobId;

            // Test 4: Get job status
            console.log('4. Getting job status...');
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait a bit
            const jobStatus = await makeRequest('GET', `/api/jobs/${jobId}`);
            console.log('   Status:', jobStatus.status);
            console.log('   Job Status:', JSON.stringify(jobStatus.data, null, 2));
            console.log('');

            // Test 5: Get all jobs
            console.log('5. Getting all jobs...');
            const allJobs = await makeRequest('GET', '/api/jobs');
            console.log('   Status:', allJobs.status);
            console.log('   Jobs:', JSON.stringify(allJobs.data, null, 2));
            console.log('');
        }

        // Test 6: Get spooler status
        console.log('6. Getting spooler status...');
        const status = await makeRequest('GET', '/api/status');
        console.log('   Status:', status.status);
        console.log('   Spooler Status:', JSON.stringify(status.data, null, 2));
        console.log('');

        console.log('✅ All tests completed successfully!');

    } catch (error) {
        console.error('❌ Error testing API:', error.message);
        console.error('   Make sure the Electron app is running on port 3001');
        process.exit(1);
    }
}

// Run tests
testAPI();

