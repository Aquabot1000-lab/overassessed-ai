
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
        
        // Send confirmation email
        if (process.env.SENDGRID_API_KEY) {
            try {
                await sgMail.send({
                    to: email,
                    from: process.env.SENDGRID_FROM_EMAIL || 'notifications@overassessed.ai',
                    subject: '🎯 Your Property Tax Savings Analysis is Ready',
                    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
                        <h2 style="color:#6c5ce7;">Your savings estimate: $${estimated_savings?.toLocaleString() || 'TBD'}</h2>
                        <p>Based on <strong>${property_address}</strong> in <strong>${county} County</strong>.</p>
                        <p>Our Texas property tax experts will contact you within 24 hours with your free detailed analysis.</p>
                        <p style="color:#636e72;font-size:14px;">— The OverAssessed Team</p>
                    </div>`
                });
            } catch (e) { console.error('Calculator lead confirmation email failed:', e.message); }
        }
        res.json({ success: true, data });
    } catch (error) {
        console.error('Calculator lead error:', error);
        res.status(500).json({ error: error.message });
    }
});
