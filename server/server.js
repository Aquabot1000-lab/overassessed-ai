const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// RentCast analysis service
const { runRentCastAnalysis, getComps: getRentCastComps } = require('./services/rentcast');

// Analysis services
const { fetchPropertyData } = require('./services/property-data');
const { findComparables } = require('./services/comp-engine');
const { generateEvidencePacket, EVIDENCE_DIR } = require('./services/evidence-generator');
const { prepareFilingPackage, FILING_DIR } = require('./services/auto-file');
const { detectState, sendStageNotification } = require('./services/notifications');

const app = express();
const PORT = process.env.PORT || 3002;

// Supabase routes (new database layer — runs alongside existing file-based routes)
const { isSupabaseEnabled, supabaseAdmin } = require('./lib/supabase');
const clientsRouter = require('./routes/clients');
const propertiesRouter = require('./routes/properties');
const appealsRouter = require('./routes/appeals');
const documentsRouter = require('./routes/documents');
const paymentsRouter = require('./routes/payments');
const exemptionsRouter = require('./routes/exemptions');
const referralsRouter = require('./routes/referrals');
const filingsRouter = require('./routes/filings');
const stripeRouter = require('./routes/stripe');
const { checkAllPendingOutcomes } = require('./services/outcome-monitor');

// Twilio setup
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// SendGrid setup
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// File upload setup
const uploadsDir = path.join(__dirname, 'uploads');
const noticesDir = path.join(__dirname, 'uploads', 'notices');
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        await fs.mkdir(uploadsDir, { recursive: true });
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const noticeStorage = multer.diskStorage({
    destination: async (req, file, cb) => {
        await fs.mkdir(noticesDir, { recursive: true });
        cb(null, noticesDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadNotice = multer({ storage: noticeStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use('/evidence-packets', express.static(path.join(__dirname, 'evidence-packets')));
app.use('/filing-packages', express.static(path.join(__dirname, 'filing-packages')));
app.use('/generated-forms', express.static(path.join(__dirname, 'generated-forms')));
app.use('/data/automation-screenshots', express.static(path.join(__dirname, '..', 'data', 'automation-screenshots')));
app.use(express.static(path.join(__dirname, '..')));

// File paths
const DATA_DIR = path.join(__dirname, 'data');
const TX_DIR = path.join(DATA_DIR, 'tx');
const GA_DIR = path.join(DATA_DIR, 'ga');
const SHARED_DIR = path.join(DATA_DIR, 'shared');
const TX_SUBMISSIONS_FILE = path.join(TX_DIR, 'submissions.json');
const GA_SUBMISSIONS_FILE = path.join(GA_DIR, 'submissions.json');
const LEGACY_SUBMISSIONS_FILE = path.join(__dirname, 'submissions.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const COUNTER_FILE = path.join(__dirname, 'counter.json');

function getSubmissionsFile(state) {
    return state === 'GA' ? GA_SUBMISSIONS_FILE : TX_SUBMISSIONS_FILE;
}

// Read all submissions from both state files
async function readAllSubmissions() {
    const [tx, ga] = await Promise.all([
        readJsonFile(TX_SUBMISSIONS_FILE),
        readJsonFile(GA_SUBMISSIONS_FILE)
    ]);
    return [...tx, ...ga];
}

// Write a submission to its state-specific file
async function writeSubmission(submission) {
    const file = getSubmissionsFile(submission.state || 'TX');
    const submissions = await readJsonFile(file);
    const idx = submissions.findIndex(s => s.id === submission.id);
    if (idx >= 0) {
        submissions[idx] = submission;
    } else {
        submissions.push(submission);
    }
    await writeJsonFile(file, submissions);
}

// Update submission in the correct state file
async function updateSubmissionInPlace(submissionId, updater) {
    // Try TX first, then GA
    for (const file of [TX_SUBMISSIONS_FILE, GA_SUBMISSIONS_FILE]) {
        const submissions = await readJsonFile(file);
        const idx = submissions.findIndex(s => s.id === submissionId || s.caseId === (submissionId || '').toUpperCase());
        if (idx >= 0) {
            updater(submissions, idx);
            await writeJsonFile(file, submissions);
            return submissions[idx];
        }
    }
    return null;
}

// Find a submission across both state files
async function findSubmission(idOrCaseId) {
    const all = await readAllSubmissions();
    return all.find(s => s.id === idOrCaseId || s.caseId === (idOrCaseId || '').toUpperCase()) || null;
}

// Initialize data files
async function initializeDataFiles() {
    // Ensure data directories exist
    await fs.mkdir(TX_DIR, { recursive: true });
    await fs.mkdir(GA_DIR, { recursive: true });
    await fs.mkdir(SHARED_DIR, { recursive: true });
    await fs.mkdir(path.join(TX_DIR, 'evidence-packets'), { recursive: true });
    await fs.mkdir(path.join(TX_DIR, 'filing-packages'), { recursive: true });
    await fs.mkdir(path.join(GA_DIR, 'evidence-packets'), { recursive: true });
    await fs.mkdir(path.join(GA_DIR, 'filing-packages'), { recursive: true });

    try { await fs.access(TX_SUBMISSIONS_FILE); } catch { await fs.writeFile(TX_SUBMISSIONS_FILE, '[]'); }
    try { await fs.access(GA_SUBMISSIONS_FILE); } catch { await fs.writeFile(GA_SUBMISSIONS_FILE, '[]'); }
    try { await fs.access(COUNTER_FILE); } catch { await fs.writeFile(COUNTER_FILE, JSON.stringify({ lastCaseNumber: 0 })); }

    // Migrate legacy submissions.json to TX if it exists
    try {
        await fs.access(LEGACY_SUBMISSIONS_FILE);
        const legacyData = await readJsonFile(LEGACY_SUBMISSIONS_FILE);
        if (legacyData.length > 0) {
            const existingTx = await readJsonFile(TX_SUBMISSIONS_FILE);
            if (existingTx.length === 0) {
                // Tag all legacy submissions as TX
                const tagged = legacyData.map(s => ({ ...s, state: s.state || 'TX' }));
                await writeJsonFile(TX_SUBMISSIONS_FILE, tagged);
                console.log(`[Migration] Migrated ${tagged.length} legacy submissions to TX`);
                // Rename old file as backup
                await fs.rename(LEGACY_SUBMISSIONS_FILE, LEGACY_SUBMISSIONS_FILE + '.bak');
            }
        }
    } catch { /* no legacy file, fine */ }
    try { await fs.access(USERS_FILE); } catch {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        const defaultUser = {
            id: uuidv4(),
            email: 'tyler@overassessed.ai',
            password: hashedPassword,
            name: 'Tyler Worthey',
            role: 'admin',
            createdAt: new Date().toISOString()
        };
        await fs.writeFile(USERS_FILE, JSON.stringify([defaultUser], null, 2));
    }
    await fs.mkdir(noticesDir, { recursive: true });
}

// Helpers
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch { return []; }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function getNextCaseId() {
    let counter;
    try {
        counter = JSON.parse(await fs.readFile(COUNTER_FILE, 'utf8'));
    } catch {
        counter = { lastCaseNumber: 0 };
    }
    counter.lastCaseNumber++;
    await fs.writeFile(COUNTER_FILE, JSON.stringify(counter));
    return `OA-${String(counter.lastCaseNumber).padStart(4, '0')}`;
}

// Notifications
async function sendSMS(to, message) {
    if (!twilioClient) { console.log('SMS skipped - no Twilio client'); return; }
    if (!to) { console.log('SMS skipped - no recipient'); return; }
    try {
        await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to
        });
        console.log('SMS sent to', to);
    } catch (error) {
        console.error('SMS failed:', error.message);
    }
}

async function sendNotificationSMS(message) {
    await sendSMS(process.env.NOTIFY_PHONE, message);
}

async function sendClientSMS(phone, message) {
    // Normalize phone to E.164
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '1' + cleaned;
    if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
    await sendSMS(cleaned, message);
}

async function sendNotificationEmail(subject, html, toEmail) {
    if (!process.env.SENDGRID_API_KEY) {
        console.log('Email skipped - missing config');
        return;
    }
    const to = toEmail || process.env.NOTIFY_EMAIL;
    if (!to) { console.log('Email skipped - no recipient'); return; }
    try {
        await sgMail.send({
            to,
            from: process.env.SENDGRID_FROM_EMAIL || 'notifications@overassessed.ai',
            subject,
            html
        });
        console.log('Email sent to', to);
    } catch (error) {
        console.error('Email failed:', error.message);
    }
}

async function sendClientEmail(toEmail, subject, html) {
    await sendNotificationEmail(subject, html, toEmail);
}

function buildNotificationContent(sub) {
    const sms = `🏠 New OverAssessed Lead!\n\nCase: ${sub.caseId}\nName: ${sub.ownerName}\nProperty: ${sub.propertyAddress}\nType: ${sub.propertyType}\nPhone: ${sub.phone}\nEmail: ${sub.email}${sub.assessedValue ? `\nAssessed: ${sub.assessedValue}` : ''}`;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <div style="background: linear-gradient(135deg, #6c5ce7, #0984e3); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                <h3 style="margin: 0;">🏠 New OverAssessed Lead — ${sub.caseId}</h3>
            </div>
            <div style="background: #f7fafc; padding: 20px; border-radius: 0 0 8px 8px;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 8px 0; font-weight: bold;">Case ID:</td><td>${sub.caseId}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: bold;">Name:</td><td>${sub.ownerName}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: bold;">Email:</td><td>${sub.email}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: bold;">Phone:</td><td>${sub.phone}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: bold;">Property:</td><td>${sub.propertyAddress}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: bold;">Type:</td><td>${sub.propertyType}</td></tr>
                    ${sub.assessedValue ? `<tr><td style="padding: 8px 0; font-weight: bold;">Assessed Value:</td><td>${sub.assessedValue}</td></tr>` : ''}
                </table>
            </div>
        </div>`;

    return { sms, html };
}

function getBaseUrl() {
    return process.env.BASE_URL || 'https://overassessed.ai';
}

function brandedEmailWrapper(title, subtitle, bodyHtml) {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #6c5ce7, #0984e3); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">${title}</h1>
            ${subtitle ? `<p style="margin: 8px 0 0; opacity: 0.9;">${subtitle}</p>` : ''}
        </div>
        <div style="background: white; padding: 30px; border: 1px solid #e2e8f0; border-top: none;">
            ${bodyHtml}
        </div>
        <div style="background: #1a1a2e; color: white; padding: 20px; border-radius: 0 0 12px 12px; text-align: center; font-size: 13px; opacity: 0.8;">
            OverAssessed, LLC — San Antonio, Texas<br>
            Questions? Reply to this email or call (210) 760-7236
        </div>
    </div>`;
}

function buildWelcomeEmail(sub) {
    const portalUrl = `${getBaseUrl()}/portal`;
    const signUrl = `${getBaseUrl()}/sign/${sub.caseId}`;
    return brandedEmailWrapper('Welcome to OverAssessed', 'Your property tax protest is underway', `
            <p>Hi ${sub.ownerName},</p>
            <p>Thank you for choosing OverAssessed! Your case has been created and our team is getting started on your property tax analysis.</p>
            
            <div style="background: #f8f9ff; border: 2px solid #6c5ce7; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
                <p style="margin: 0 0 5px; font-size: 14px; color: #6b7280;">Your Case ID</p>
                <p style="margin: 0; font-size: 28px; font-weight: 800; color: #6c5ce7;">${sub.caseId}</p>
            </div>
            
            <h3 style="color: #2d3436;">What happens next:</h3>
            <ol style="color: #4a5568; line-height: 2;">
                <li>Our team analyzes your property assessment against comparable sales</li>
                <li>You'll receive your analysis report (usually within 24-48 hours)</li>
                <li>Sign the authorization form so we can file on your behalf</li>
            </ol>

            <div style="text-align: center; margin: 25px 0;">
                <a href="${signUrl}" style="background: linear-gradient(135deg, #6c5ce7, #0984e3); color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 700; font-size: 16px;">Sign Authorization Form →</a>
            </div>
            <p style="font-size: 13px; color: #6b7280; text-align: center;">Or <a href="${portalUrl}" style="color: #6c5ce7;">view your client portal</a> — log in with your email and case ID: <strong>${sub.caseId}</strong></p>
    `);
}

// ===== STATUS UPDATE EMAIL TEMPLATES =====
function buildStatusEmail(sub, newStatus, extras) {
    const portalUrl = `${getBaseUrl()}/portal`;
    const templates = {
        'Analysis Complete': {
            title: 'Your Analysis is Ready! 📊',
            subtitle: `Case ${sub.caseId}`,
            body: `<p>Hi ${sub.ownerName},</p>
                <p>Great news — our team has completed the analysis for your property at <strong>${sub.propertyAddress}</strong>.</p>
                ${sub.estimatedSavings ? `<div style="background:#f8f9ff;border:2px solid #00b894;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
                    <p style="margin:0 0 5px;color:#6b7280;">Estimated Annual Tax Savings</p>
                    <p style="margin:0;font-size:32px;font-weight:800;color:#00b894;">$${sub.estimatedSavings.toLocaleString()}</p>
                </div>` : ''}
                <p>Log into your portal to view the full report and sign the authorization form:</p>
                <div style="text-align:center;margin:20px 0;">
                    <a href="${getBaseUrl()}/sign/${sub.caseId}" style="background:linear-gradient(135deg,#6c5ce7,#0984e3);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">Sign Authorization & View Report</a>
                </div>`,
            sms: `OverAssessed: Your analysis is ready${sub.estimatedSavings ? ` — estimated savings: $${sub.estimatedSavings.toLocaleString()}/yr` : ''}! Sign your authorization form to proceed: ${getBaseUrl()}/sign/${sub.caseId}`
        },
        'Protest Filed': {
            title: 'Your Protest Has Been Filed! 📤',
            subtitle: `Case ${sub.caseId}`,
            body: `<p>Hi ${sub.ownerName},</p>
                <p>We've officially filed your property tax protest for <strong>${sub.propertyAddress}</strong> with the appraisal district.</p>
                <p>Our team will handle everything from here. We'll notify you when your hearing is scheduled or if we reach an early settlement.</p>
                <div style="text-align:center;margin:20px 0;">
                    <a href="${portalUrl}" style="background:linear-gradient(135deg,#6c5ce7,#0984e3);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">View Your Portal</a>
                </div>`,
            sms: `OverAssessed: Your property tax protest for ${sub.propertyAddress} has been filed! We'll keep you updated on progress.`
        },
        'Hearing Scheduled': {
            title: 'Your Hearing is Scheduled 🏛️',
            subtitle: `Case ${sub.caseId}`,
            body: `<p>Hi ${sub.ownerName},</p>
                <p>A hearing has been scheduled for your property tax protest on <strong>${sub.propertyAddress}</strong>.</p>
                <p>Our team will represent you — no action is needed on your part. We'll let you know the outcome as soon as the hearing concludes.</p>
                <div style="text-align:center;margin:20px 0;">
                    <a href="${portalUrl}" style="background:linear-gradient(135deg,#6c5ce7,#0984e3);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">View Your Portal</a>
                </div>`,
            sms: `OverAssessed: A hearing has been scheduled for your property tax protest. Our team will represent you — no action needed!`
        },
        'Resolved': {
            title: 'Your Case is Resolved! ✅',
            subtitle: `Case ${sub.caseId}`,
            body: `<p>Hi ${sub.ownerName},</p>
                <p>Great news — your property tax protest for <strong>${sub.propertyAddress}</strong> has been resolved!</p>
                ${(extras && extras.savings) ? `<div style="background:#f8f9ff;border:2px solid #00b894;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
                    <p style="margin:0 0 5px;color:#6b7280;">Your Annual Tax Savings</p>
                    <p style="margin:0;font-size:32px;font-weight:800;color:#00b894;">$${Number(extras.savings).toLocaleString()}</p>
                </div>` : ''}
                <p>Thank you for trusting OverAssessed. We're glad we could help reduce your property taxes.</p>
                <div style="text-align:center;margin:20px 0;">
                    <a href="${portalUrl}" style="background:linear-gradient(135deg,#6c5ce7,#0984e3);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">View Final Details</a>
                </div>`,
            sms: `OverAssessed: Your property tax protest is resolved!${(extras && extras.savings) ? ` You're saving $${Number(extras.savings).toLocaleString()}/year!` : ''} View details in your portal.`
        }
    };
    return templates[newStatus] || null;
}

// ===== DRIP / FOLLOW-UP SEQUENCE =====
async function runDripCheck() {
    console.log('[Drip] Running follow-up check...');
    try {
        const submissions = await readAllSubmissions();
        const now = Date.now();
        let changed = false;

        for (let i = 0; i < submissions.length; i++) {
            const sub = submissions[i];
            // Only drip on unsigned cases that are New or Analysis Complete
            if (sub.signature) continue;
            if (!['New', 'Analysis Complete'].includes(sub.status)) continue;

            const created = new Date(sub.createdAt).getTime();
            const hoursSince = (now - created) / (1000 * 60 * 60);
            const drip = sub.dripState || {};
            const signUrl = `${getBaseUrl()}/sign/${sub.caseId}`;

            // 24hr reminder email
            if (hoursSince >= 24 && !drip.reminder24) {
                console.log(`[Drip] 24hr reminder email → ${sub.email} (${sub.caseId})`);
                sendClientEmail(sub.email, `Reminder: Sign Your Authorization — ${sub.caseId}`,
                    brandedEmailWrapper('Quick Reminder', `Case ${sub.caseId}`, `
                        <p>Hi ${sub.ownerName},</p>
                        <p>Just a friendly reminder — we still need your signed Form 50-162 to proceed with your property tax protest for <strong>${sub.propertyAddress}</strong>.</p>
                        <p>It only takes a minute:</p>
                        <div style="text-align:center;margin:25px 0;">
                            <a href="${signUrl}" style="background:linear-gradient(135deg,#6c5ce7,#0984e3);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">Sign Now →</a>
                        </div>
                        <p style="font-size:13px;color:#6b7280;">This authorization allows our team to file your protest on your behalf.</p>
                    `)
                );
                drip.reminder24 = new Date().toISOString();
                changed = true;
            }

            // 48hr reminder SMS
            if (hoursSince >= 48 && !drip.reminder48) {
                console.log(`[Drip] 48hr reminder SMS → ${sub.phone} (${sub.caseId})`);
                sendClientSMS(sub.phone, `OverAssessed reminder: We still need your signed authorization to file your property tax protest. Sign here: ${signUrl}`);
                drip.reminder48 = new Date().toISOString();
                changed = true;
            }

            // 72hr final email + SMS to Tyler
            if (hoursSince >= 72 && !drip.reminder72) {
                console.log(`[Drip] 72hr final reminder → ${sub.email} + Tyler alert (${sub.caseId})`);
                sendClientEmail(sub.email, `Action Needed: Don't Miss Out — ${sub.caseId}`,
                    brandedEmailWrapper('Don\'t Miss Your Deadline', `Case ${sub.caseId}`, `
                        <p>Hi ${sub.ownerName},</p>
                        <p>We haven't received your signed authorization yet for <strong>${sub.propertyAddress}</strong>. Property tax protest deadlines are approaching and we don't want you to miss out on potential savings.</p>
                        <p>Please take a moment to sign — it only takes 60 seconds:</p>
                        <div style="text-align:center;margin:25px 0;">
                            <a href="${signUrl}" style="background:linear-gradient(135deg,#e17055,#d63031);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">Sign Before It's Too Late →</a>
                        </div>
                        <p>If you have any questions or concerns, please reply to this email or call us at (210) 760-7236.</p>
                    `)
                );
                // Alert Tyler to call them
                sendNotificationSMS(`⚠️ Follow-up needed!\n${sub.ownerName} hasn't signed Form 50-162 after 72hrs.\nCase: ${sub.caseId}\nPhone: ${sub.phone}\nPlease call them.`);
                sendNotificationEmail(`⚠️ Follow-up Needed — ${sub.caseId} ${sub.ownerName}`,
                    `<div style="font-family:Arial;"><p><strong>${sub.ownerName}</strong> hasn't signed their Form 50-162 after 72 hours.</p>
                    <p>Case: ${sub.caseId}<br>Phone: <a href="tel:${sub.phone}">${sub.phone}</a><br>Email: ${sub.email}<br>Property: ${sub.propertyAddress}</p>
                    <p><strong>Please call them to follow up.</strong></p></div>`
                );
                drip.reminder72 = new Date().toISOString();
                changed = true;
            }

            submissions[i].dripState = drip;
        }

        if (changed) {
            // Write back changed submissions to their respective state files
            const txSubs = submissions.filter(s => (s.state || 'TX') === 'TX');
            const gaSubs = submissions.filter(s => s.state === 'GA');
            if (txSubs.length) await writeJsonFile(TX_SUBMISSIONS_FILE, txSubs);
            if (gaSubs.length) await writeJsonFile(GA_SUBMISSIONS_FILE, gaSubs);
            console.log('[Drip] Updated drip states');
        } else {
            console.log('[Drip] No actions needed');
        }
    } catch (error) {
        console.error('[Drip] Error:', error.message);
    }
}

// Auth middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, process.env.JWT_SECRET || 'overassessed-secret-key-2026', (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// ==================== SUPABASE DB ROUTES (new — /api/db/*) ====================
// These run alongside existing file-based routes. Existing routes are untouched.
if (isSupabaseEnabled()) {
    console.log('✅ Supabase enabled — mounting /api/db/* routes');
    app.use('/api/db/clients', authenticateToken, clientsRouter);
    app.use('/api/db/properties', authenticateToken, propertiesRouter);
    app.use('/api/db/appeals', authenticateToken, appealsRouter);
    app.use('/api/db/documents', authenticateToken, documentsRouter);
    app.use('/api/db/payments', authenticateToken, paymentsRouter);
    app.use('/api/db/exemptions', authenticateToken, exemptionsRouter);
    app.use('/api/db/referrals', authenticateToken, referralsRouter);
    app.use('/api/filings', authenticateToken, filingsRouter);
} else {
    console.log('⚠️  Supabase not configured — /api/db/* routes disabled');
}

// ==================== PUBLIC ROUTES (no auth) ====================
// These must be mounted before any auth-gated routes
if (isSupabaseEnabled()) {
    // Public exemption intake
    app.use('/api/exemptions', exemptionsRouter);
    // Public referral endpoints
    app.use('/api/referrals', referralsRouter);
    // Stripe payment routes (webhook is public, others are authenticated via admin check)
    app.use('/api/stripe', stripeRouter);
    console.log('✅ Public routes mounted: /api/exemptions, /api/referrals, /api/stripe');
}

// ==================== ROUTES ====================

// ==================== OUTCOME MONITOR ROUTES ====================
// POST /api/admin/check-outcomes — manually trigger outcome check for all pending appeals
app.post('/api/admin/check-outcomes', authenticateToken, async (req, res) => {
    try {
        const result = await checkAllPendingOutcomes();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== RENTCAST ANALYSIS ROUTES ====================
// POST /api/analysis/run — full RentCast + ArcGIS analysis for any address
app.post('/api/analysis/run', authenticateToken, async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ error: 'Address is required' });
        console.log(`[RentCast] Running analysis for: ${address}`);
        const result = await runRentCastAnalysis(address);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[RentCast] Analysis error:', error.message);
        res.status(500).json({ error: 'Analysis failed: ' + error.message });
    }
});

// GET /api/analysis/comps — comparables only
app.get('/api/analysis/comps', authenticateToken, async (req, res) => {
    try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ error: 'Address query param required' });
        const comps = await getRentCastComps(address);
        res.json({ success: true, address, comparables: comps });
    } catch (error) {
        console.error('[RentCast] Comps error:', error.message);
        res.status(500).json({ error: 'Failed to fetch comps: ' + error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', service: 'OverAssessed', timestamp: new Date().toISOString() });
});

// Auth
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const users = await readJsonFile(USERS_FILE);
        const user = users.find(u => u.email === email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const secret = process.env.JWT_SECRET || 'overassessed-secret-key-2026';
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ==================== CLIENT PORTAL AUTH ====================
app.post('/api/portal/login', async (req, res) => {
    try {
        const { email, caseId } = req.body;
        if (!email || !caseId) return res.status(400).json({ error: 'Email and Case ID required' });

        const submissions = await readAllSubmissions();
        const sub = submissions.find(s => s.email.toLowerCase() === email.toLowerCase() && s.caseId === caseId.toUpperCase());
        if (!sub) return res.status(401).json({ error: 'No case found with that email and case ID' });

        res.json({ success: true, submission: sub });
    } catch (error) {
        console.error('Portal login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// GET portal data by case ID + email (simple auth via query params)
app.get('/api/portal/case', async (req, res) => {
    try {
        const { email, caseId } = req.query;
        if (!email || !caseId) return res.status(400).json({ error: 'Missing email or caseId' });

        const submissions = await readAllSubmissions();
        const sub = submissions.find(s => s.email.toLowerCase() === email.toLowerCase() && s.caseId === caseId.toUpperCase());
        if (!sub) return res.status(404).json({ error: 'Case not found' });

        // Return sanitized data (no internal IDs exposed unnecessarily)
        res.json(sub);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch case' });
    }
});

// ==================== PRE-REGISTRATION ====================
app.post('/api/pre-register', async (req, res) => {
    try {
        const { name, email, phone, property_address, county } = req.body;
        if (!name || !email || !property_address || !county) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!isSupabaseEnabled()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const insertData = { name, email, property_address, county };
        if (phone) insertData.phone = phone;
        const { data, error } = await supabaseAdmin.from('pre_registrations').insert(insertData).select().single();
        if (error) throw error;

        // Send confirmation email
        if (process.env.SENDGRID_API_KEY) {
            try {
                await sgMail.send({
                    to: email,
                    from: process.env.SENDGRID_FROM_EMAIL || 'notifications@overassessed.ai',
                    subject: '✅ You\'re Pre-Registered for TX Property Tax Season!',
                    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
                        <h2 style="color:#6c5ce7;">You're on the list, ${name}!</h2>
                        <p>We'll analyze <strong>${property_address}</strong> in <strong>${county} County</strong> the moment appraisal notices drop in April.</p>
                        <p>You'll get a head start on your protest — no action needed until then.</p>
                        <p style="color:#636e72;font-size:14px;">— The OverAssessed Team</p>
                    </div>`
                });
            } catch (e) { console.error('Pre-reg confirmation email failed:', e.message); }
        }
        // Notify admin
        try { await sendNotificationSMS(`New pre-registration: ${name} (${email}) — ${property_address}, ${county} County`); } catch(e) {}
        try { await sendNotificationEmail('New Pre-Registration', `<p><strong>${name}</strong> (${email})<br>${property_address}<br>${county} County</p>`); } catch(e) {}

        res.json({ success: true, id: data.id });
    } catch (error) {
        console.error('Pre-registration error:', error);
        res.status(500).json({ error: 'Failed to save pre-registration' });
    }
});

app.post('/api/calculator-lead', async (req, res) => {
    try {
        const { name, email, phone, property_address, county, assessed_value, estimated_savings, property_type } = req.body;
        if (!name || !email || !property_address || !county || !assessed_value) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!isSupabaseEnabled()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const insertData = { 
            name, email, property_address, county, 
            assessed_value: parseInt(assessed_value),
            estimated_savings: parseInt(estimated_savings || 0),
            property_type: property_type || 'residential',
            source: 'calculator'
        };
        if (phone) insertData.phone = phone;
        const { data, error } = await supabaseAdmin.from('calculator_leads').insert(insertData).select().single();
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        console.error('Calculator lead error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pre-registrations/count', async (req, res) => {
    try {
        if (!isSupabaseEnabled()) return res.json({ count: 0 });
        const { count, error } = await supabaseAdmin.from('pre_registrations')
            .select('*', { count: 'exact', head: true });
        if (error) throw error;
        res.json({ count: count || 0 });
    } catch (error) {
        res.json({ count: 0 });
    }
});

app.get('/api/pre-registrations', authenticateToken, async (req, res) => {
    try {
        if (!isSupabaseEnabled()) return res.json([]);
        const { data, error } = await supabaseAdmin.from('pre_registrations')
            .select('*').order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pre-registrations' });
    }
});

// ==================== INTAKE (enhanced) ====================
app.post('/api/intake', upload.single('noticeFile'), async (req, res) => {
    try {
        const { propertyAddress, propertyType, ownerName, phone, email, assessedValue, source, utm_data, county, notificationPref, ref,
                bedrooms, bathrooms, sqft, yearBuilt, renovations, renovationDesc, conditionIssues, conditionDesc, recentAppraisal, appraisedValue, appraisalDate,
                stripeCustomerId, stripePaymentMethodId } = req.body;
        if (!propertyAddress || !propertyType || !ownerName || !phone || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const caseId = await getNextCaseId();
        const state = detectState(source, county);

        const submission = {
            id: uuidv4(),
            caseId,
            propertyAddress,
            propertyType,
            ownerName,
            phone,
            email,
            assessedValue: assessedValue || null,
            state,
            county: county || null,
            notificationPref: notificationPref || 'both',
            bedrooms: bedrooms ? parseInt(bedrooms) : null,
            bathrooms: bathrooms ? parseFloat(bathrooms) : null,
            sqft: sqft ? parseInt(sqft) : null,
            yearBuilt: yearBuilt ? parseInt(yearBuilt) : null,
            renovations: renovations || 'No',
            renovationDesc: renovationDesc || null,
            conditionIssues: conditionIssues || 'No',
            conditionDesc: conditionDesc || null,
            recentAppraisal: recentAppraisal || 'No',
            appraisedValue: appraisedValue || null,
            appraisalDate: appraisalDate || null,
            noticeFile: req.file ? `/uploads/${req.file.filename}` : null,
            noticeOfValue: null,
            source: source || 'website',
            utm_data: utm_data ? (typeof utm_data === 'string' ? JSON.parse(utm_data) : utm_data) : null,
            status: 'New',
            notes: [],
            savings: null,
            estimatedSavings: null,
            analysisReport: null,
            signature: null,
            pin: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Check for referral code
        if (ref && isSupabaseEnabled()) {
            try {
                const { data: referral } = await supabaseAdmin
                    .from('referrals')
                    .select('*')
                    .eq('referral_code', ref)
                    .single();

                if (referral) {
                    const discountedRate = (submission.state === 'GA') ? 0.20 : 0.15;
                    submission.referralCode = ref;
                    submission.discountedRate = discountedRate;
                    submission.referralId = referral.id;

                    // Link the referral to this new client
                    await supabaseAdmin
                        .from('referrals')
                        .update({
                            referred_email: email.toLowerCase(),
                            referred_name: ownerName,
                            referred_phone: phone || null,
                            status: 'claimed'
                        })
                        .eq('id', referral.id);

                    console.log(`[Intake] Referral ${ref} applied — discounted rate: ${discountedRate}`);
                }
            } catch (refErr) {
                console.log('[Intake] Referral lookup failed:', refErr.message);
            }
        }

        // Save Stripe customer ID to client record if provided (card on file)
        if (stripeCustomerId && isSupabaseEnabled()) {
            try {
                await supabaseAdmin
                    .from('clients')
                    .update({ stripe_customer_id: stripeCustomerId })
                    .eq('email', email.toLowerCase());
                console.log(`[Intake] Stripe customer ${stripeCustomerId} linked to ${email}`);
                
                // Set the payment method as default for the customer
                if (stripePaymentMethodId && process.env.STRIPE_SECRET_KEY) {
                    const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);
                    await stripeLib.customers.update(stripeCustomerId, {
                        invoice_settings: { default_payment_method: stripePaymentMethodId }
                    });
                    console.log(`[Intake] Default payment method set for ${email}`);
                }
            } catch (stripeErr) {
                console.log('[Intake] Stripe customer link failed:', stripeErr.message);
            }
        }

        await writeSubmission(submission);

        // Send notifications to Tyler
        const { sms, html } = buildNotificationContent(submission);
        sendNotificationSMS(sms);
        sendNotificationEmail('New OverAssessed Lead: ' + ownerName + ' (' + caseId + ')', html);

        // Send welcome notification to client via stage notification engine
        const notifyFns = { sendClientSMS, sendClientEmail, brandedEmailWrapper };
        sendStageNotification(submission, 'submitted', {}, notifyFns);

        // Also send the rich welcome email (existing branded flow)
        const welcomeHtml = buildWelcomeEmail(submission);
        sendClientEmail(email, `Welcome to OverAssessed — Case ${caseId}`, welcomeHtml);

        // Auto-trigger full analysis pipeline (async, don't block response)
        setTimeout(async () => {
            try {
                console.log(`[AutoAnalysis] Starting auto-analysis for new case ${caseId}`);
                await runFullAnalysis(submission.id);
                console.log(`[AutoAnalysis] Complete for ${caseId}`);
                // Notify Tyler that analysis is ready
                sendNotificationSMS(`📊 Auto-analysis complete!\nCase: ${caseId}\nProperty: ${propertyAddress}\nEvidence packet ready for review.`);
                sendNotificationEmail(`📊 Analysis Ready — ${caseId} ${ownerName}`,
                    `<p>Auto-analysis complete for <strong>${caseId}</strong> — ${propertyAddress}.</p>
                    <p>Evidence packet is generated and ready for review in the admin dashboard.</p>`);
            } catch (err) {
                console.error(`[AutoAnalysis] Failed for ${caseId}:`, err.message);
            }
        }, 2000);

        res.json({ success: true, message: 'Submitted successfully', id: submission.id, caseId });
    } catch (error) {
        console.error('Intake error:', error);
        res.status(500).json({ error: 'Failed to process submission' });
    }
});

// ==================== E-SIGNATURE (Form 50-162) ====================
// GET signing data
app.get('/api/sign/:id', async (req, res) => {
    try {
        const sub = await findSubmission(req.params.id);
        if (!sub) return res.status(404).json({ error: 'Case not found' });

        res.json({
            caseId: sub.caseId,
            ownerName: sub.ownerName,
            propertyAddress: sub.propertyAddress,
            email: sub.email,
            phone: sub.phone,
            propertyType: sub.propertyType,
            state: sub.state || 'TX',
            county: sub.county || null,
            signed: !!sub.signature
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load signing data' });
    }
});

// POST submit signature
app.post('/api/sign/:id', async (req, res) => {
    try {
        const { fullName, authorized, email } = req.body;
        if (!fullName || !authorized) {
            return res.status(400).json({ error: 'Full name and authorization checkbox required' });
        }

        const sub = await updateSubmissionInPlace(req.params.id, (submissions, idx) => {
            const s = submissions[idx];
            const state = s.state || 'TX';
            const docsSigned = state === 'GA'
                ? ['service_agreement', 'letter_of_authorization']
                : ['form_50_162'];

            submissions[idx].signature = {
                fullName,
                authorized: true,
                signedAt: new Date().toISOString(),
                ipAddress: req.ip,
                documentsSigned: docsSigned
            };

            if (['New', 'Analysis Complete'].includes(submissions[idx].status)) {
                submissions[idx].status = 'Form Signed';
            }
            submissions[idx].updatedAt = new Date().toISOString();
        });

        if (!sub) return res.status(404).json({ error: 'Case not found' });

        const state = sub.state || 'TX';
        const formName = state === 'GA' ? 'Service Agreement & Letter of Authorization' : 'Form 50-162';

        // Notify Tyler
        sendNotificationEmail(
            `${formName} Signed — ${sub.caseId} ${sub.ownerName}`,
            `<div style="font-family:Arial;max-width:600px;">
                <div style="background:linear-gradient(135deg,#6c5ce7,#0984e3);color:white;padding:20px;border-radius:8px 8px 0 0;">
                    <h3 style="margin:0;">✍️ ${formName} Signed</h3>
                </div>
                <div style="background:#f7fafc;padding:20px;">
                    <p><strong>Case:</strong> ${sub.caseId}</p>
                    <p><strong>State:</strong> ${state}</p>
                    <p><strong>Client:</strong> ${sub.ownerName}</p>
                    <p><strong>Property:</strong> ${sub.propertyAddress}</p>
                    <p><strong>Signed Name:</strong> ${fullName}</p>
                    <p><strong>Signed At:</strong> ${new Date().toLocaleString()}</p>
                </div>
            </div>`
        );
        sendNotificationSMS(`✍️ ${formName} signed!\nCase: ${sub.caseId}\nClient: ${sub.ownerName}\nState: ${state}`);

        // Send stage notification to client
        const notifyFns = { sendClientSMS, sendClientEmail, brandedEmailWrapper };
        sendStageNotification(sub, 'docs_signed', {}, notifyFns);

        res.json({ success: true, message: 'Form signed successfully' });
    } catch (error) {
        console.error('Signature error:', error);
        res.status(500).json({ error: 'Failed to submit signature' });
    }
});

// ==================== FULL ANALYSIS ENGINE ====================

// Helper: find submission and its state file
async function findSubmissionWithFile(idOrCaseId) {
    for (const file of [TX_SUBMISSIONS_FILE, GA_SUBMISSIONS_FILE]) {
        const submissions = await readJsonFile(file);
        const idx = submissions.findIndex(s => s.id === idOrCaseId || s.caseId === (idOrCaseId || '').toUpperCase());
        if (idx >= 0) return { file, submissions, idx };
    }
    return null;
}

// Run the complete analysis pipeline for a case
async function runFullAnalysis(caseId) {
    const found = await findSubmissionWithFile(caseId);
    if (!found) throw new Error('Case not found');
    let { file, submissions, idx } = found;

    const sub = submissions[idx];
    console.log(`[Analysis] Starting full analysis for ${sub.caseId}: ${sub.propertyAddress}`);

    // Helper to save progress
    async function saveProgress() {
        await writeJsonFile(file, submissions);
    }

    // Update status
    submissions[idx].analysisStatus = 'Analyzing';
    submissions[idx].updatedAt = new Date().toISOString();
    await saveProgress();

    // Step 1: Fetch property data
    console.log(`[Analysis] Step 1: Fetching property data...`);
    const propertyData = await fetchPropertyData(sub);
    submissions[idx].propertyData = propertyData;
    await saveProgress();

    // Step 2: Find comparables
    console.log(`[Analysis] Step 2: Finding comparable properties...`);
    const compResults = await findComparables(propertyData, sub);
    submissions[idx].compResults = compResults;
    submissions[idx].analysisStatus = 'Comps Found';
    await saveProgress();

    // Step 3: Generate evidence packet
    console.log(`[Analysis] Step 3: Generating evidence packet...`);
    const evidencePath = await generateEvidencePacket(sub, propertyData, compResults);
    submissions[idx].evidencePacketPath = evidencePath;
    submissions[idx].analysisStatus = 'Evidence Generated';
    await saveProgress();

    // Step 4: Build analysis report
    const assessedNum = propertyData.assessedValue || parseInt((sub.assessedValue || '0').replace(/[^0-9]/g, '')) || 300000;
    const report = {
        generatedAt: new Date().toISOString(),
        propertyAddress: sub.propertyAddress,
        propertyType: propertyData.propertyType || sub.propertyType,
        currentAssessedValue: assessedNum,
        estimatedMarketValue: compResults.recommendedValue,
        estimatedReduction: compResults.reduction,
        estimatedTaxSavings: compResults.estimatedSavings,
        taxRate: compResults.taxRate,
        comparables: compResults.comps.map(c => ({
            address: c.address,
            value: c.assessedValue,
            adjustedValue: c.adjustedValue,
            sqft: c.sqft,
            yearBuilt: c.yearBuilt,
            score: c.score,
            pricePerSqft: c.pricePerSqft
        })),
        methodology: compResults.methodology,
        recommendation: compResults.estimatedSavings > 0
            ? 'PROTEST RECOMMENDED — Strong basis for reduction based on comparable sales analysis.'
            : 'Assessment appears in line with market. Limited protest potential.',
        reportHtml: buildAnalysisHtml(sub, propertyData, compResults)
    };

    submissions[idx].analysisReport = report;
    submissions[idx].estimatedSavings = compResults.estimatedSavings;
    if (compResults.needsManualReview) {
        submissions[idx].needsManualReview = true;
        submissions[idx].reviewReason = compResults.reviewReason;
    }
    if (submissions[idx].status === 'New') {
        submissions[idx].status = 'Analysis Complete';
    }
    submissions[idx].updatedAt = new Date().toISOString();
    await saveProgress();

    console.log(`[Analysis] Complete for ${sub.caseId}. Savings: $${compResults.estimatedSavings}`);
    return { report, propertyData, compResults, evidencePath };
}

function buildAnalysisHtml(sub, propertyData, compResults) {
    const assessedNum = propertyData.assessedValue || 0;
    return `
<div style="font-family: Arial, sans-serif; max-width: 700px;">
    <h2 style="color: #6c5ce7; border-bottom: 2px solid #6c5ce7; padding-bottom: 10px;">Property Tax Protest Analysis</h2>
    <p><strong>Property:</strong> ${sub.propertyAddress}</p>
    <p><strong>Owner:</strong> ${sub.ownerName}</p>
    <p><strong>Case:</strong> ${sub.caseId}</p>
    <p><strong>Generated:</strong> ${new Date().toLocaleDateString()}</p>
    
    <div style="background: #f8f9ff; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <h3 style="color: #2d3436; margin-top: 0;">Summary</h3>
        <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #6b7280;">Current Assessed Value:</td><td style="font-weight: 700;">$${assessedNum.toLocaleString()}</td></tr>
            <tr><td style="padding: 8px 0; color: #6b7280;">Recommended Value:</td><td style="font-weight: 700; color: #0984e3;">$${compResults.recommendedValue.toLocaleString()}</td></tr>
            <tr><td style="padding: 8px 0; color: #6b7280;">Potential Reduction:</td><td style="font-weight: 700; color: #00b894;">$${compResults.reduction.toLocaleString()}</td></tr>
            <tr><td style="padding: 8px 0; color: #6b7280;">Estimated Tax Savings:</td><td style="font-weight: 700; color: #00b894; font-size: 1.2em;">$${compResults.estimatedSavings.toLocaleString()}/year</td></tr>
        </table>
    </div>
    
    <h3 style="color: #2d3436;">Comparable Properties</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead><tr style="background: #6c5ce7; color: white;">
            <th style="padding: 10px; text-align: left;">Address</th>
            <th style="padding: 10px; text-align: right;">Assessed</th>
            <th style="padding: 10px; text-align: right;">Adjusted</th>
            <th style="padding: 10px; text-align: center;">Score</th>
        </tr></thead>
        <tbody>
            ${compResults.comps.map((c, i) => `<tr style="background: ${i % 2 ? '#f8f9ff' : 'white'}">
                <td style="padding: 10px;">${c.address}</td>
                <td style="padding: 10px; text-align: right;">$${(c.assessedValue || 0).toLocaleString()}</td>
                <td style="padding: 10px; text-align: right; color: ${c.adjustedValue < assessedNum ? '#00b894' : '#e17055'};">$${(c.adjustedValue || 0).toLocaleString()}</td>
                <td style="padding: 10px; text-align: center;">${c.score}/100</td>
            </tr>`).join('')}
        </tbody>
    </table>
    
    <h3 style="color: #2d3436;">Methodology</h3>
    <p style="color: #4a5568;">${compResults.methodology}</p>
    
    <div style="background: ${compResults.estimatedSavings > 0 ? '#c6f6d5' : '#fed7d7'}; border-radius: 8px; padding: 15px; margin: 20px 0;">
        <strong>${compResults.estimatedSavings > 0 ? 'PROTEST RECOMMENDED' : 'LIMITED PROTEST POTENTIAL'}</strong>
    </div>
</div>`;
}

// Main analyze endpoint
app.post('/api/analyze/:id', authenticateToken, async (req, res) => {
    try {
        const result = await runFullAnalysis(req.params.id);

        // Email client
        const sub = await findSubmission(req.params.id);
        if (sub) {
            const portalUrl = process.env.BASE_URL ? `${process.env.BASE_URL}/portal` : 'https://overassessed.ai/portal';
            sendClientEmail(sub.email, `Your Analysis is Ready — ${sub.caseId}`,
                brandedEmailWrapper('Your Analysis is Ready! 📊', `Case ${sub.caseId}`, `
                    <p>Hi ${sub.ownerName},</p>
                    <p>Great news — we've completed the analysis for your property at <strong>${sub.propertyAddress}</strong>.</p>
                    <div style="background:#f8f9ff;border:2px solid #00b894;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
                        <p style="margin:0 0 5px;color:#6b7280;">Estimated Annual Tax Savings</p>
                        <p style="margin:0;font-size:32px;font-weight:800;color:#00b894;">$${result.compResults.estimatedSavings.toLocaleString()}</p>
                    </div>
                    <p>Log into your portal to view the full report and sign the authorization form:</p>
                    <div style="text-align:center;margin:20px 0;">
                        <a href="${getBaseUrl()}/sign/${sub.caseId}" style="background:linear-gradient(135deg,#6c5ce7,#0984e3);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">View Your Report →</a>
                    </div>
                `)
            );
        }

        res.json({ success: true, estimatedSavings: result.compResults.estimatedSavings, report: result.report });
    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: 'Failed to run analysis: ' + error.message });
    }
});

// Alias: POST /api/cases/:id/analyze
app.post('/api/cases/:id/analyze', authenticateToken, async (req, res) => {
    try {
        const result = await runFullAnalysis(req.params.id);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET property data for a case
app.get('/api/cases/:id/property-data', authenticateToken, async (req, res) => {
    try {
        const submissions = await readAllSubmissions();
        const sub = submissions.find(s => s.id === req.params.id || s.caseId === (req.params.id || '').toUpperCase());
        if (!sub) return res.status(404).json({ error: 'Case not found' });
        res.json(sub.propertyData || { error: 'No property data yet. Run analysis first.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET comps for a case
app.get('/api/cases/:id/comps', authenticateToken, async (req, res) => {
    try {
        const submissions = await readAllSubmissions();
        const sub = submissions.find(s => s.id === req.params.id || s.caseId === (req.params.id || '').toUpperCase());
        if (!sub) return res.status(404).json({ error: 'Case not found' });
        res.json(sub.compResults || { error: 'No comp data yet. Run analysis first.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST generate evidence packet (standalone)
app.post('/api/cases/:id/generate-evidence', authenticateToken, async (req, res) => {
    try {
        const sub = await findSubmission(req.params.id);
        if (!sub) return res.status(404).json({ error: 'Case not found' });
        if (!sub.propertyData || !sub.compResults) return res.status(400).json({ error: 'Run analysis first' });

        const evidencePath = await generateEvidencePacket(sub, sub.propertyData, sub.compResults);
        await updateSubmissionInPlace(req.params.id, (submissions, idx) => {
            submissions[idx].evidencePacketPath = evidencePath;
            submissions[idx].analysisStatus = 'Evidence Generated';
            submissions[idx].updatedAt = new Date().toISOString();
        });

        res.json({ success: true, path: evidencePath });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET download evidence packet
app.get('/api/cases/:id/evidence-packet', (req, res, next) => {
    // Allow token via query param for direct download links
    if (req.query.token && !req.headers['authorization']) {
        req.headers['authorization'] = 'Bearer ' + req.query.token;
    }
    next();
}, authenticateToken, async (req, res) => {
    try {
        const submissions = await readAllSubmissions();
        const sub = submissions.find(s => s.id === req.params.id || s.caseId === (req.params.id || '').toUpperCase());
        if (!sub) return res.status(404).json({ error: 'Case not found' });
        if (!sub.evidencePacketPath) return res.status(404).json({ error: 'No evidence packet generated yet' });

        const filePath = sub.evidencePacketPath;
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: 'Evidence file not found on disk' });
        }
        res.download(filePath);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST prepare filing package
app.post('/api/cases/:id/prepare-filing', authenticateToken, async (req, res) => {
    try {
        const sub = await findSubmission(req.params.id);
        if (!sub) return res.status(404).json({ error: 'Case not found' });
        if (!sub.propertyData || !sub.compResults) return res.status(400).json({ error: 'Run analysis first' });

        const filingData = await prepareFilingPackage(sub, sub.propertyData, sub.compResults);
        await updateSubmissionInPlace(req.params.id, (submissions, idx) => {
            submissions[idx].filingData = filingData;
            submissions[idx].analysisStatus = 'Ready to File';
            submissions[idx].updatedAt = new Date().toISOString();
        });

        res.json({ success: true, filingData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET download filing package
app.get('/api/cases/:id/filing-package', (req, res, next) => {
    if (req.query.token && !req.headers['authorization']) {
        req.headers['authorization'] = 'Bearer ' + req.query.token;
    }
    next();
}, authenticateToken, async (req, res) => {
    try {
        const submissions = await readAllSubmissions();
        const sub = submissions.find(s => s.id === req.params.id || s.caseId === (req.params.id || '').toUpperCase());
        if (!sub || !sub.filingData || !sub.filingData.filingPdfPath) return res.status(404).json({ error: 'No filing package' });
        res.download(sub.filingData.filingPdfPath);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST bulk analyze
app.post('/api/cases/bulk-analyze', authenticateToken, async (req, res) => {
    try {
        const submissions = await readAllSubmissions();
        const newCases = submissions.filter(s => s.status === 'New' || s.analysisStatus === 'Not Started');
        const ids = (req.body.ids || newCases.map(s => s.id));

        const results = [];
        for (const id of ids) {
            try {
                await runFullAnalysis(id);
                results.push({ id, status: 'analyzed' });
            } catch (e) {
                results.push({ id, status: 'error', error: e.message });
            }
        }
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Legacy bulk analyze alias
app.post('/api/analyze-bulk', authenticateToken, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
        const results = [];
        for (const id of ids) {
            try {
                await runFullAnalysis(id);
                results.push({ id, status: 'analyzed' });
            } catch (e) {
                results.push({ id, status: 'error', error: e.message });
            }
        }
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: 'Bulk analysis failed' });
    }
});

// ==================== NOTICE UPLOAD ====================
app.post('/api/upload-notice/:id', uploadNotice.single('notice'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const filePath = `/uploads/notices/${req.file.filename}`;
        const pinMatch = req.file.originalname.match(/(\d{6,})/);
        const sub = await updateSubmissionInPlace(req.params.id, (submissions, idx) => {
            submissions[idx].noticeOfValue = filePath;
            submissions[idx].updatedAt = new Date().toISOString();
            if (pinMatch) submissions[idx].pin = pinMatch[1];
        });
        if (!sub) return res.status(404).json({ error: 'Case not found' });

        sendNotificationEmail(
            `Notice Uploaded — ${sub.caseId}`,
            `<p>Client ${sub.ownerName} uploaded their Notice of Appraised Value for case ${sub.caseId}.</p>`
        );

        res.json({ success: true, message: 'Notice uploaded', filePath });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload notice' });
    }
});

// ==================== PIPELINE STATS ====================
app.get('/api/pipeline-stats', authenticateToken, async (req, res) => {
    try {
        const submissions = await readAllSubmissions();
        const statuses = ['New', 'Analysis Complete', 'Form Signed', 'Protest Filed', 'Hearing Scheduled', 'Resolved'];
        const pipeline = {};
        statuses.forEach(s => pipeline[s] = 0);
        // Count legacy statuses too
        submissions.forEach(s => {
            if (pipeline[s.status] !== undefined) {
                pipeline[s.status]++;
            } else {
                pipeline[s.status] = (pipeline[s.status] || 0) + 1;
            }
        });

        const totalEstimatedSavings = submissions.reduce((sum, s) => sum + (s.estimatedSavings || 0), 0);
        const totalFees = Math.round(totalEstimatedSavings * 0.20);
        const signed = submissions.filter(s => s.signature).length;
        const notices = submissions.filter(s => s.noticeOfValue).length;

        res.json({ pipeline, totalEstimatedSavings, totalFees, signed, notices, total: submissions.length });
    } catch (error) {
        res.status(500).json({ error: 'Failed to compute pipeline stats' });
    }
});

// ==================== STATUS UPDATE (with client notifications) ====================
app.patch('/api/submissions/:id/status', authenticateToken, async (req, res) => {
    try {
        const { status, savings } = req.body;
        if (!status) return res.status(400).json({ error: 'Status required' });

        let oldStatus = null;
        const sub = await updateSubmissionInPlace(req.params.id, (submissions, idx) => {
            oldStatus = submissions[idx].status;
            submissions[idx].status = status;
            if (savings !== undefined) submissions[idx].savings = savings;
            submissions[idx].updatedAt = new Date().toISOString();
        });
        if (!sub) return res.status(404).json({ error: 'Not found' });

        // Send status notification to client if status actually changed
        if (oldStatus !== status) {
            const template = buildStatusEmail(sub, status, { savings: savings || sub.savings });
            if (template) {
                sendClientEmail(sub.email, `${template.title} — ${sub.caseId}`, brandedEmailWrapper(template.title, template.subtitle, template.body));
                sendClientSMS(sub.phone, template.sms);
                console.log(`Status notification sent to ${sub.email} for ${status}`);
            }
        }

        res.json(sub);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// ==================== EXISTING ROUTES (kept) ====================
app.get('/api/submissions', authenticateToken, async (req, res) => {
    try {
        let submissions = await readAllSubmissions();
        const stateFilter = req.query.state;
        if (stateFilter && stateFilter !== 'all') {
            submissions = submissions.filter(s => (s.state || 'TX') === stateFilter.toUpperCase());
        }
        submissions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(submissions);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch submissions' });
    }
});

app.get('/api/submissions/:id', authenticateToken, async (req, res) => {
    try {
        const sub = await findSubmission(req.params.id);
        if (!sub) return res.status(404).json({ error: 'Not found' });
        res.json(sub);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch submission' });
    }
});

app.patch('/api/submissions/:id', authenticateToken, async (req, res) => {
    try {
        const { status, note, savings } = req.body;
        let oldStatus = null;
        const sub = await updateSubmissionInPlace(req.params.id, (submissions, idx) => {
            oldStatus = submissions[idx].status;
            if (status) submissions[idx].status = status;
            if (savings !== undefined) submissions[idx].savings = savings;
            if (note) {
                submissions[idx].notes.push({
                    id: uuidv4(),
                    text: note,
                    author: req.user.email,
                    createdAt: new Date().toISOString()
                });
            }
            submissions[idx].updatedAt = new Date().toISOString();
        });
        if (!sub) return res.status(404).json({ error: 'Not found' });

        // Send status notification to client if status changed
        if (status && oldStatus !== status) {
            const template = buildStatusEmail(sub, status, { savings: savings || sub.savings });
            if (template) {
                sendClientEmail(sub.email, `${template.title} — ${sub.caseId}`, brandedEmailWrapper(template.title, template.subtitle, template.body));
                sendClientSMS(sub.phone, template.sms);
            }
        }

        res.json(sub);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update submission' });
    }
});

app.post('/api/notify', authenticateToken, async (req, res) => {
    try {
        const { submissionId } = req.body;
        const sub = await findSubmission(submissionId);
        if (!sub) return res.status(404).json({ error: 'Submission not found' });

        const { sms, html } = buildNotificationContent(sub);
        await sendNotificationSMS(sms);
        await sendNotificationEmail('OverAssessed — Re-notification: ' + sub.ownerName, html);
        res.json({ success: true, message: 'Notifications sent' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send notifications' });
    }
});

app.get('/api/stats', authenticateToken, async (req, res) => {
    try {
        const submissions = await readAllSubmissions();
        const total = submissions.length;
        const active = submissions.filter(s => ['New', 'Analysis Complete', 'Form Signed', 'Protest Filed', 'Hearing Scheduled', 'In Review', 'Appeal Filed'].includes(s.status)).length;
        const won = submissions.filter(s => s.status === 'Won' || s.status === 'Resolved').length;
        const lost = submissions.filter(s => s.status === 'Lost').length;
        const decided = won + lost;
        const winRate = decided > 0 ? Math.round((won / decided) * 100) : 0;
        const totalSavings = submissions.reduce((sum, s) => sum + (parseFloat(s.savings) || 0), 0);

        res.json({ total, active, won, lost, winRate, totalSavings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to compute stats' });
    }
});

// ==================== SERVE PAGES ====================
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

app.get('/portal', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'portal.html'));
});

app.get('/sign/:id', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'sign.html'));
});

// Landing pages
app.get('/lp/san-antonio', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'san-antonio.html'));
});

app.get('/lp/texas', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'texas.html'));
});

app.get('/lp/commercial', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'commercial.html'));
});

app.get('/lp/georgia', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'georgia.html'));
});

// PPC Landing Pages
app.get('/ppc/property-tax-protest', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-property-tax-protest.html'));
});
app.get('/ppc/bexar', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-bexar.html'));
});
app.get('/ppc/harris', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-harris.html'));
});
app.get('/ppc/dallas', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-dallas.html'));
});
app.get('/ppc/tarrant', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-tarrant.html'));
});

// Texas county landing pages (2026 SEO campaign)
app.get('/lp/bexar-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'bexar-county.html'));
});
app.get('/lp/comal-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'comal-county.html'));
});
app.get('/lp/guadalupe-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'guadalupe-county.html'));
});
app.get('/lp/hays-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'hays-county.html'));
});

// Missing county routes (fixed 2026-03-03)
app.get('/collin-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'collin-county.html'));
});
app.get('/denton-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'denton-county.html'));
});
app.get('/fort-bend-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'fort-bend-county.html'));
});
app.get('/williamson-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'williamson-county.html'));
});
app.get('/montgomery-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'montgomery-county.html'));
});
app.get('/el-paso-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'el-paso-county.html'));
});
app.get('/hidalgo-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'hidalgo-county.html'));
});
app.get('/guadalupe-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'guadalupe-county.html'));
});
app.get('/comal-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'comal-county.html'));
});
app.get('/hays-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'hays-county.html'));
});
app.get('/lp/travis-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'travis-county.html'));
});
app.get('/lp/williamson-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'williamson-county.html'));
});
app.get('/lp/dallas-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'dallas-county.html'));
});
app.get('/lp/harris-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'harris-county.html'));
});
app.get('/lp/tarrant-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'tarrant-county.html'));
});
app.get('/lp/collin-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'collin-county.html'));
});
app.get('/lp/denton-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'denton-county.html'));
});
app.get('/lp/fort-bend-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'fort-bend-county.html'));
});
app.get('/lp/montgomery-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'montgomery-county.html'));
});
app.get('/lp/el-paso-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'el-paso-county.html'));
});
app.get('/lp/hidalgo-county', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'lp', 'hidalgo-county.html'));
});

// County-specific landing pages

// PPC Landing Pages (Google Ads / paid traffic)
app.get('/ppc/property-tax-protest', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-property-tax-protest.html'));
});
app.get('/ppc/bexar', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-bexar.html'));
});
app.get('/ppc/harris', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-harris.html'));
});
app.get('/ppc/dallas', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-dallas.html'));
});
app.get('/ppc/tarrant', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ppc-tarrant.html'));
});
app.get('/bexar-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'bexar-county.html'));
});
app.get('/harris-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'harris-county.html'));
});
app.get('/travis-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'travis-county.html'));
});
app.get('/dallas-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'dallas-county.html'));
});
app.get('/tarrant-county', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'tarrant-county.html'));
});

app.get('/georgia', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'georgia.html'));
});

app.get('/texas', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'texas.html'));
});

app.get('/san-antonio', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'lp', 'san-antonio.html'));
});

app.get('/pre-register', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'pre-register.html'));
});

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'privacy.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'terms.html'));
});

app.get('/calculator', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'calculator.html'));
});

app.get('/sitemap.xml', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'sitemap.xml'));
});

app.get('/robots.txt', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'robots.txt'));
});

app.get('/exemptions', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'exemptions.html'));
});

app.get('/referrals', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'referrals.html'));
});

// Catch-all: serve frontend
app.get('{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start
async function startServer() {
    await initializeDataFiles();
    app.listen(PORT, () => {
        console.log(`🚀 OverAssessed running on port ${PORT}`);
        console.log(`📱 SMS: ${twilioClient ? 'Enabled' : 'Disabled'}`);
        console.log(`📧 Email: ${process.env.SENDGRID_API_KEY ? 'Enabled' : 'Disabled'}`);
        console.log(`👤 Notify: ${process.env.NOTIFY_PHONE || 'N/A'} | ${process.env.NOTIFY_EMAIL || 'N/A'}`);
        console.log(`🔄 Drip sequence: checking every hour`);
        console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Enabled (auto-invoice)' : 'Disabled'}`);
        console.log(`🔍 Outcome monitor: checking every 6 hours`);
    });

    // Run drip check every hour
    setInterval(runDripCheck, 60 * 60 * 1000);
    // Also run once 30 seconds after startup
    setTimeout(runDripCheck, 30000);

    // Run outcome monitor every 6 hours (checks county sites for hearing results)
    setInterval(async () => {
        try {
            const result = await checkAllPendingOutcomes();
            if (result.updated > 0) {
                console.log(`[OutcomeMonitor] Updated ${result.updated} appeals`);
            }
        } catch (e) {
            console.error('[OutcomeMonitor] Scheduled check error:', e.message);
        }
    }, 6 * 60 * 60 * 1000);
    // First check 2 minutes after startup
    setTimeout(async () => {
        try { await checkAllPendingOutcomes(); } catch (e) { console.error('[OutcomeMonitor]', e.message); }
    }, 120000);
}

startServer();
