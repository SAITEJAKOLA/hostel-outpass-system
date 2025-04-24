const { insertOutpass, updateStatus, getStatus } = require('./utils/db');
const { generateQR } = require('./utils/qr');
const { sendEmail, sendSMS } = require('./utils/notify');
const { verifyRecordDb } = require('./utils/db');
const requestOutpass = async (event, context) => {
	try {
		const body = JSON.parse(event.body);
		console.log('API ENDPOINT:', process.env.API_ENDPOINT);

		// Validate required fields
		const requiredFields = [
			'studentName',
			'rollNumber',
			'studentMobile',
			'parentMobile',
			'reason',
		];
		for (const field of requiredFields) {
			if (!body[field]) {
				return {
					statusCode: 400,
					body: JSON.stringify({
						error: `Missing required field: ${field}`,
					}),
				};
			}
		}

		const { studentName, rollNumber, studentMobile, parentMobile, reason } =
			body;

		// Insert outpass request
		const insertedRecord = await insertOutpass(
			studentName,
			rollNumber,
			studentMobile,
			parentMobile,
			reason
		);
		console.log('Inserted record:', insertedRecord);

		// Create HTML email content with buttons
		const emailBody = `
        <html>
        <body>
            <h2>Outpass Request</h2>
            <p><strong>Student:</strong> ${studentName}</p>
            <p><strong>Roll Number:</strong> ${rollNumber}</p>
            <p><strong>Reason:</strong> ${reason}</p>
            
            <div style="margin-top: 20px;">
                <form action="${process.env.API_ENDPOINT}/approve" method="POST" style="display: inline;">
                    <input type="hidden" name="id" value="${rollNumber}">
                    <input type="hidden" name="button" value="approve">
                    <input type="submit" value="Approve" 
                           style="background-color: #4CAF50; color: white; padding: 10px 20px; 
                                  border: none; border-radius: 4px; cursor: pointer; margin-right: 10px;">
                </form>

                <form action="${process.env.API_ENDPOINT}/approve" method="POST" style="display: inline;">
                    <input type="hidden" name="id" value="${rollNumber}">
                    <input type="hidden" name="button" value="reject">
                    <input type="submit" value="Reject" 
                           style="background-color: #f44336; color: white; padding: 10px 20px; 
                                  border: none; border-radius: 4px; cursor: pointer;">
                </form>
            </div>
        </body>
        </html>`;

		// Send notifications
		await Promise.all([
			sendEmail(process.env.SES_EMAIL, 'New Outpass Request', emailBody, true), // Set HTML flag to true
			sendSMS(studentMobile, 'Outpass requested. Awaiting approval.'),
			sendSMS(
				parentMobile,
				'Your ward requested an outpass. Awaiting approval.'
			),
		]);

		return {
			statusCode: 200,
			body: JSON.stringify({
				message: 'Outpass request submitted successfully',
				record: insertedRecord,
				requestDetails: {
					id: rollNumber,
					studentName,
					reason,
					status: 'Pending',
				},
			}),
		};
	} catch (error) {
		console.error('Error:', error);
		return {
			statusCode: 500,
			body: JSON.stringify({
				error: 'Internal server error',
			}),
		};
	}
};

const processApproval = async (event, context) => {
	try {
		let id, decision;
		console.log('Received event:', event);
		console.log('Headers:', event.headers);

		// Get content-type header in a case-insensitive way
		const contentType = Object.keys(event.headers).find(
			(key) => key.toLowerCase() === 'content-type'
		);
		const contentTypeValue = event.headers[contentType];

		// Check if the data is form-encoded
		if (
			contentTypeValue &&
			contentTypeValue
				.toLowerCase()
				.includes('application/x-www-form-urlencoded')
		) {
			// Parse form data
			const formData = new URLSearchParams(event.body);
			id = formData.get('id');
			decision = formData.get('button');
			console.log('Form data parsed:', { id, decision });
		} else {
			// Parse JSON data
			console.log('Attempting to parse JSON:', event.body);
			const body = JSON.parse(event.body);
			id = body.id;
			decision = body.decision;
		}

		console.log('Received request:', { id, decision });

		// Validate required parameters
		if (!id || !decision) {
			return {
				statusCode: 400,
				body: JSON.stringify({
					error: 'Missing parameters. Both id and decision are required.',
				}),
			};
		}

		// Validate decision value
		const validDecisions = ['approve', 'reject'];
		if (!validDecisions.includes(decision.toLowerCase())) {
			return {
				statusCode: 400,
				body: JSON.stringify({
					error: 'Invalid decision. Must be either "approve" or "reject"',
				}),
			};
		}

		// Get current status first to prevent unnecessary updates
		const currentStatus = await getStatus(id);
		if (currentStatus === 'Approved' || currentStatus === 'Rejected') {
			return {
				statusCode: 400,
				body: JSON.stringify({
					error: `Outpass request has already been ${currentStatus.toLowerCase()}`,
				}),
			};
		}

		// Update the status
		const status = decision.charAt(0).toUpperCase() + decision.slice(1);
		await updateStatus(id, status);

		// If approved, generate QR code and notify student and parent
		if (decision.toLowerCase() === 'approve') {
			// Get the record first to have all details
			const record = await verifyRecordDb(id);
			console.log('Record fetched for QR generation:', record);

			if (!record) {
				throw new Error('Record not found');
			}

			// Generate QR with presigned URL
			const qrUrl = await generateQR(`OUTPASS:${id}`, `${id}.png`);
			if (record.parent_mobile) {
				// Format the phone number to E.164 format
				let parentMobile = record.parent_mobile;

				// Create a more detailed message
				const smsMessage =
					`Outpass Approved for ${record.student_name}\n` +
					`Roll No: ${id}\n` +
					`View QR: ${qrUrl}\n` +
					`Valid for 24 hours\n` +
					`Do not share this link`;

				// Send SMS with formatted number and detailed message
				try {
					await sendSMS(parentMobile, smsMessage);
					console.log('SMS sent successfully to:', parentMobile);
				} catch (smsError) {
					console.error('Failed to send SMS:', smsError);
					// Continue execution even if SMS fails
				}
			}

			return {
				statusCode: 200,
				headers: {
					'Content-Type': 'text/html',
				},
				body: `
                    <html>
                        <body>
                            <h2>Success!</h2>
                            <p>Outpass has been approved successfully.</p>
                            <p>QR Code has been generated and sent to parent's mobile number.</p>
                            <p>The QR code link will expire in 24 hours.</p>
                            <script>
                                setTimeout(() => {
                                    window.close();
                                }, 3000);
                            </script>
                        </body>
                    </html>
                `,
			};
		}

		// If rejected
		return {
			statusCode: 200,
			headers: {
				'Content-Type': 'text/html',
			},
			body: `
                <html>
                    <body>
                        <h2>Success!</h2>
                        <p>Outpass has been rejected.</p>
                        <script>
                            setTimeout(() => {
                                window.close();
                            }, 3000);
                        </script>
                    </body>
                </html>
            `,
		};
	} catch (error) {
		console.error('Error:', error);
		return {
			statusCode: 500,
			body: JSON.stringify({
				error: 'Internal server error',
				details: error.message,
			}),
		};
	}
};

const verifyQR = async (event, context) => {
	try {
		const { id } = event.queryStringParameters || {};
		const status = await getStatus(id);

		if (status === 'Approved') {
			return {
				statusCode: 200,
				body: JSON.stringify({ message: 'QR valid. Access granted.' }),
			};
		}

		return {
			statusCode: 403,
			body: JSON.stringify({ message: 'QR invalid or not approved.' }),
		};
	} catch (error) {
		console.error('Error:', error);
		return {
			statusCode: 500,
			body: JSON.stringify({ error: 'Internal server error' }),
		};
	}
};

const verifyRecord = async (event, context) => {
	try {
		const { rollNumber } = event.queryStringParameters || {};

		if (!rollNumber) {
			return {
				statusCode: 400,
				body: JSON.stringify({ error: 'Roll number is required' }),
			};
		}

		const record = await verifyRecordDb(rollNumber);

		if (!record) {
			return {
				statusCode: 404,
				body: JSON.stringify({ message: 'Record not found' }),
			};
		}

		return {
			statusCode: 200,
			body: JSON.stringify({
				message: 'Record found',
				record,
			}),
		};
	} catch (error) {
		console.error('Error:', error);
		return {
			statusCode: 500,
			body: JSON.stringify({
				error: 'Internal server error',
				details: error.message,
			}),
		};
	}
};

module.exports = {
	requestOutpass,
	processApproval,
	verifyQR,
	verifyRecord,
};
