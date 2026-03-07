const express = require('express');
const router = express.Router();
const sgMail = require('@sendgrid/mail');
const fs = require('fs');
const path = require('path');

// Email sequences config
const SEQUENCES = {
  'pre-reg': {
    file: 'pre-registration-drip.md',
    count: 5,
    name: 'Pre-Registration Drip'
  },
  'post-signup': {
    file: 'post-signup-sequence.md',
    count: 4,
    name: 'Post-Signup Sequence'
  },
  'referral': {
    file: 'referral-nudge.md',
    count: 3,
    name: 'Referral Nudge'
  },
  'win': {
    file: 'win-notification.md',
    count: 1,
    name: 'Win Notification'
  }
};

// Parse email content from markdown files
function parseSequenceEmails(sequenceKey) {
  const seq = SEQUENCES[sequenceKey];
  if (!seq) return null;

  const filePath = path.join(__dirname, '..', '..', 'marketing', 'email-nurture', seq.file);
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  
  // Split by email markers (## Email 1, ## Email 2, etc.)
  const emails = [];
  const emailBlocks = content.split(/^## Email \d+/m).slice(1);
  
  for (const block of emailBlocks) {
    // Extract subject from first line after split
    const subjectMatch = block.match(/Subject:\s*(.+)/i) || block.match(/\*\*Subject:\*\*\s*(.+)/i);
    const subject = subjectMatch ? subjectMatch[1].replace(/[`*]/g, '').trim() : `OverAssessed.ai Update`;
    
    // Extract HTML content between ```html and ```
    const htmlMatch = block.match(/```html\n([\s\S]*?)```/);
    const htmlContent = htmlMatch ? htmlMatch[1].trim() : null;
    
    // Extract send timing
    const timingMatch = block.match(/Send:\s*(.+)/i) || block.match(/Timing:\s*(.+)/i) || block.match(/\*\*Send:\*\*\s*(.+)/i);
    const timing = timingMatch ? timingMatch[1].replace(/[`*]/g, '').trim() : 'Manual';

    emails.push({ subject, htmlContent, timing });
  }
  
  return emails;
}

// Replace template variables
function replaceVariables(html, vars = {}) {
  let result = html;
  const defaults = {
    '{{FIRST_NAME}}': vars.firstName || 'there',
    '{{LAST_NAME}}': vars.lastName || '',
    '{{FULL_NAME}}': vars.fullName || vars.firstName || 'there',
    '{{EMAIL}}': vars.email || '',
    '{{PROPERTY_ADDRESS}}': vars.propertyAddress || 'your property',
    '{{COUNTY}}': vars.county || 'your county',
    '{{REFERRAL_CODE}}': vars.referralCode || '',
    '{{SAVINGS_ESTIMATE}}': vars.savingsEstimate || '$500-$5,000',
    '{{CURRENT_YEAR}}': new Date().getFullYear().toString(),
  };
  
  for (const [key, value] of Object.entries(defaults)) {
    result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
  }
  return result;
}

// POST /api/email/nurture — Send a specific nurture email
router.post('/nurture', async (req, res) => {
  try {
    const { clientId, sequence, emailIndex, email, firstName, lastName, propertyAddress, county, referralCode, savingsEstimate } = req.body;
    
    if (!sequence || emailIndex === undefined) {
      return res.status(400).json({ error: 'sequence and emailIndex are required' });
    }
    
    if (!SEQUENCES[sequence]) {
      return res.status(400).json({ error: `Invalid sequence. Options: ${Object.keys(SEQUENCES).join(', ')}` });
    }

    const emails = parseSequenceEmails(sequence);
    if (!emails || !emails[emailIndex]) {
      return res.status(400).json({ error: `Email ${emailIndex} not found in ${sequence} sequence` });
    }

    const emailData = emails[emailIndex];
    if (!emailData.htmlContent) {
      return res.status(400).json({ error: `Email ${emailIndex} has no HTML content in the template` });
    }

    const recipientEmail = email || req.body.to;
    if (!recipientEmail) {
      return res.status(400).json({ error: 'email (recipient) is required' });
    }

    if (!process.env.SENDGRID_API_KEY) {
      return res.status(503).json({ error: 'SendGrid not configured. Set SENDGRID_API_KEY env var.' });
    }

    const html = replaceVariables(emailData.htmlContent, {
      firstName, lastName, fullName: `${firstName || ''} ${lastName || ''}`.trim(),
      email: recipientEmail, propertyAddress, county, referralCode, savingsEstimate
    });

    const msg = {
      to: recipientEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'notifications@overassessed.ai',
      subject: replaceVariables(emailData.subject, { firstName }),
      html: html,
    };

    await sgMail.send(msg);
    console.log(`📧 Sent ${sequence} email #${emailIndex} to ${recipientEmail}`);
    
    res.json({ 
      success: true, 
      message: `Sent ${SEQUENCES[sequence].name} email #${emailIndex + 1} to ${recipientEmail}`,
      subject: msg.subject
    });
  } catch (error) {
    console.error('Email nurture error:', error);
    res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
});

// POST /api/email/test — Send a test email
router.post('/test', async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to (email address) is required' });

    if (!process.env.SENDGRID_API_KEY) {
      return res.status(503).json({ error: 'SendGrid not configured. Set SENDGRID_API_KEY env var.' });
    }

    const msg = {
      to,
      from: process.env.SENDGRID_FROM_EMAIL || 'notifications@overassessed.ai',
      subject: 'OverAssessed.ai — Email Test ✅',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px;">
          <h2 style="color: #6c5ce7;">Email System Working! ✅</h2>
          <p>This is a test email from OverAssessed.ai.</p>
          <p>If you're seeing this, SendGrid is properly configured and ready to send nurture sequences.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">Sent at: ${new Date().toISOString()}</p>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log(`📧 Test email sent to ${to}`);
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ error: 'Failed to send test email', details: error.message });
  }
});

// GET /api/email/sequences — List available sequences
router.get('/sequences', (req, res) => {
  const result = {};
  for (const [key, seq] of Object.entries(SEQUENCES)) {
    const emails = parseSequenceEmails(key);
    result[key] = {
      name: seq.name,
      emailCount: emails ? emails.length : 0,
      emails: emails ? emails.map((e, i) => ({ index: i, subject: e.subject, timing: e.timing })) : []
    };
  }
  res.json(result);
});

// ── Email Capture / Subscribe ──

router.post('/subscribe', async (req, res) => {
  try {
    const { email, county, name } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    // Try Supabase first
    let saved = false;
    try {
      const { isSupabaseEnabled, supabaseAdmin } = require('../lib/supabase');
      if (isSupabaseEnabled()) {
        // Create table if needed (idempotent via upsert)
        const { error } = await supabaseAdmin
          .from('email_subscribers')
          .upsert({ email: email.toLowerCase(), county: county || null, name: name || null, subscribed: true }, { onConflict: 'email' });

        if (error && error.code === '42P01') {
          // Table doesn't exist yet — fall through to file storage
          console.log('[Email] email_subscribers table not found, using file fallback');
        } else if (error) {
          console.error('[Email] Supabase error:', error);
        } else {
          saved = true;
          console.log(`[Email] Subscriber saved to Supabase: ${email} (${county || 'no county'})`);
        }
      }
    } catch (e) {
      console.warn('[Email] Supabase unavailable, using file fallback');
    }

    // File fallback if Supabase is down or not configured
    if (!saved) {
      const dataDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const subsFile = path.join(dataDir, 'email-subscribers.json');
      let subs = [];
      if (fs.existsSync(subsFile)) {
        subs = JSON.parse(fs.readFileSync(subsFile, 'utf-8'));
      }
      // Check for duplicate
      if (!subs.find(s => s.email === email.toLowerCase())) {
        subs.push({
          email: email.toLowerCase(),
          county: county || null,
          name: name || null,
          subscribedAt: new Date().toISOString()
        });
        fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2));
      }
      console.log(`[Email] Subscriber saved to file: ${email}`);
    }

    res.json({ success: true, message: 'Subscribed successfully' });
  } catch (err) {
    console.error('[Email] Subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
      const { isSupabaseEnabled, supabaseAdmin } = require('../lib/supabase');
      if (isSupabaseEnabled()) {
        await supabaseAdmin
          .from('email_subscribers')
          .update({ subscribed: false })
          .eq('email', email.toLowerCase());
      }
    } catch (e) {}

    // Also remove from file
    const subsFile = path.join(__dirname, '..', 'data', 'email-subscribers.json');
    if (fs.existsSync(subsFile)) {
      let subs = JSON.parse(fs.readFileSync(subsFile, 'utf-8'));
      subs = subs.filter(s => s.email !== email.toLowerCase());
      fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2));
    }

    res.json({ success: true, message: 'Unsubscribed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

module.exports = router;
