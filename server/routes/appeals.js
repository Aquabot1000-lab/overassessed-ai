const express = require('express');
const router = express.Router();
const { supabaseAdmin, isSupabaseEnabled } = require('../lib/supabase');

// Stripe auto-invoicing & auto-charging
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
let chargeSavedCard;
try { chargeSavedCard = require('./stripe').chargeSavedCard; } catch (e) { chargeSavedCard = null; }

/**
 * Auto-generate and send a Stripe invoice when an appeal is won.
 * Called automatically when status → 'won' and savings_amount is present.
 */
async function autoInvoiceClient(appeal) {
    if (!stripe) {
        console.log('[AutoInvoice] Stripe not configured — skipping');
        return null;
    }

    const clientId = appeal.client_id;
    const savingsAmount = parseFloat(appeal.savings_amount);
    if (!savingsAmount || savingsAmount <= 0) {
        console.log('[AutoInvoice] No savings amount — skipping');
        return null;
    }

    // Determine fee percentage based on state
    const state = (appeal.state || 'TX').toUpperCase();
    const feePercent = appeal.our_fee_percent || (state === 'TX' ? 20 : state === 'GA' ? 25 : 20);
    const feeAmount = Math.round(savingsAmount * (feePercent / 100) * 100) / 100;

    if (feeAmount < 1) {
        console.log('[AutoInvoice] Fee too small ($' + feeAmount + ') — skipping');
        return null;
    }

    try {
        // STEP 1: Try auto-charging the card on file first
        if (chargeSavedCard) {
            const description = `Property Tax Appeal Fee — ${feePercent}% of $${savingsAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} verified tax savings`;
            const chargeResult = await chargeSavedCard(clientId, appeal.id, feeAmount, description);
            if (chargeResult && chargeResult.success) {
                console.log(`[AutoInvoice] ✅ Auto-charged card on file: ${chargeResult.email} for $${feeAmount}`);
                // Update appeal
                await supabaseAdmin
                    .from('appeals')
                    .update({
                        our_fee_percent: feePercent,
                        our_fee_amount: feeAmount,
                        payment_status: 'paid'
                    })
                    .eq('id', appeal.id);
                return { ...chargeResult, feeAmount, method: 'auto_charge' };
            }
            console.log(`[AutoInvoice] No card on file or charge failed — falling back to invoice`);
        }

        // STEP 2: Fall back to sending a Stripe invoice
        // Get client info
        const { data: client, error: clientErr } = await supabaseAdmin
            .from('clients')
            .select('*')
            .eq('id', clientId)
            .single();
        if (clientErr || !client) throw new Error('Client not found: ' + clientId);

        // Get property info for description
        let propertyAddress = 'your property';
        if (appeal.properties?.address) {
            propertyAddress = appeal.properties.address;
        } else {
            const { data: prop } = await supabaseAdmin
                .from('properties')
                .select('address')
                .eq('id', appeal.property_id)
                .single();
            if (prop) propertyAddress = prop.address;
        }

        // Find or create Stripe customer
        let stripeCustomerId = client.stripe_customer_id;
        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                name: client.name,
                email: client.email,
                phone: client.phone || undefined,
                metadata: { supabase_client_id: clientId, source: 'overassessed.ai' }
            });
            stripeCustomerId = customer.id;
            await supabaseAdmin
                .from('clients')
                .update({ stripe_customer_id: stripeCustomerId })
                .eq('id', clientId);
        }

        // Create invoice
        const invoice = await stripe.invoices.create({
            customer: stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: 30,
            metadata: {
                client_id: clientId,
                appeal_id: appeal.id,
                case_id: appeal.case_id || '',
                source: 'overassessed.ai'
            }
        });

        // Add line item
        const description = `Property Tax Appeal Fee — ${feePercent}% of $${savingsAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} verified tax savings for ${propertyAddress} (Case ${appeal.case_id || appeal.id})`;

        await stripe.invoiceItems.create({
            customer: stripeCustomerId,
            invoice: invoice.id,
            amount: Math.round(feeAmount * 100),
            currency: 'usd',
            description
        });

        // Finalize and send
        const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
        await stripe.invoices.sendInvoice(invoice.id);

        // Record payment in Supabase
        await supabaseAdmin.from('payments').insert({
            client_id: clientId,
            appeal_id: appeal.id,
            stripe_payment_id: invoice.id,
            amount: feeAmount,
            status: 'invoiced'
        });

        // Update appeal with fee info and payment status
        await supabaseAdmin
            .from('appeals')
            .update({
                our_fee_percent: feePercent,
                our_fee_amount: feeAmount,
                payment_status: 'invoiced'
            })
            .eq('id', appeal.id);

        console.log(`[AutoInvoice] ✅ Invoice sent to ${client.email} for $${feeAmount} (Case ${appeal.case_id})`);
        return {
            invoice_id: invoice.id,
            invoice_url: finalizedInvoice.hosted_invoice_url,
            amount: feeAmount,
            email: client.email
        };
    } catch (err) {
        console.error('[AutoInvoice] ❌ Error:', err.message);
        return null;
    }
}

// GET /api/appeals
router.get('/', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        let query = supabaseAdmin.from('appeals').select('*, clients(name, email, phone), properties(address, city, state)');
        if (req.query.status) query = query.eq('status', req.query.status);
        if (req.query.state) query = query.eq('state', req.query.state.toUpperCase());
        if (req.query.client_id) query = query.eq('client_id', req.query.client_id);
        const { data, error } = await query.order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('[Appeals] GET error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/appeals/:id
router.get('/:id', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        // Support lookup by UUID or case_id
        const col = req.params.id.startsWith('OA-') ? 'case_id' : 'id';
        const { data, error } = await supabaseAdmin
            .from('appeals')
            .select('*, clients(name, email, phone, notification_pref), properties(address, city, state, county, property_type, current_assessed_value), documents(*)')
            .eq(col, req.params.id)
            .single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Appeal not found' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/appeals — create a full appeal (client + property + appeal in one shot)
router.post('/', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        const {
            // Client fields
            ownerName, email, phone, notificationPref,
            // Property fields
            propertyAddress, propertyType, assessedValue, county,
            // Appeal fields
            state, source, utm_data
        } = req.body;

        if (!ownerName || !email || !propertyAddress) {
            return res.status(400).json({ error: 'ownerName, email, and propertyAddress required' });
        }

        const appealState = (state || 'TX').toUpperCase();

        // 1. Upsert client
        let { data: client, error: clientErr } = await supabaseAdmin
            .from('clients')
            .select('id')
            .eq('email', email.toLowerCase())
            .maybeSingle();

        if (!client) {
            const { data: newClient, error: insertErr } = await supabaseAdmin
                .from('clients')
                .insert({
                    name: ownerName,
                    email: email.toLowerCase(),
                    phone,
                    state: appealState,
                    county,
                    notification_pref: notificationPref || 'both'
                })
                .select()
                .single();
            if (insertErr) throw insertErr;
            client = newClient;
        }

        // 2. Create property
        const assessedNum = assessedValue ? parseInt(String(assessedValue).replace(/[^0-9]/g, '')) || null : null;
        const { data: property, error: propErr } = await supabaseAdmin
            .from('properties')
            .insert({
                client_id: client.id,
                address: propertyAddress,
                state: appealState,
                county,
                property_type: propertyType,
                current_assessed_value: assessedNum
            })
            .select()
            .single();
        if (propErr) throw propErr;

        // 3. Generate case ID
        const { data: caseIdRow, error: caseErr } = await supabaseAdmin.rpc('next_case_id');
        if (caseErr) throw caseErr;
        const caseId = caseIdRow;

        // 4. Create appeal
        const { data: appeal, error: appealErr } = await supabaseAdmin
            .from('appeals')
            .insert({
                case_id: caseId,
                property_id: property.id,
                client_id: client.id,
                state: appealState,
                county,
                status: 'intake',
                source: source || 'website',
                utm_data: utm_data || null
            })
            .select()
            .single();
        if (appealErr) throw appealErr;

        res.status(201).json({
            success: true,
            id: appeal.id,
            caseId,
            clientId: client.id,
            propertyId: property.id
        });
    } catch (err) {
        console.error('[Appeals] POST error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/appeals/:id
router.patch('/:id', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        const col = req.params.id.startsWith('OA-') ? 'case_id' : 'id';
        const allowed = [
            'status', 'filing_date', 'hearing_date', 'outcome',
            'estimated_savings', 'savings_amount', 'our_fee_percent', 'our_fee_amount',
            'notes', 'signature', 'drip_state', 'analysis_report', 'analysis_status',
            'evidence_packet_path', 'filing_data', 'pin', 'payment_status'
        ];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }

        // Handle adding a note (append to JSONB array)
        if (req.body.note) {
            // Fetch current notes first
            const { data: current } = await supabaseAdmin
                .from('appeals')
                .select('notes')
                .eq(col, req.params.id)
                .single();
            const existingNotes = current?.notes || [];
            existingNotes.push({
                id: require('crypto').randomUUID(),
                text: req.body.note,
                author: req.body.author || 'admin',
                createdAt: new Date().toISOString()
            });
            updates.notes = existingNotes;
        }

        const { data, error } = await supabaseAdmin
            .from('appeals')
            .update(updates)
            .eq(col, req.params.id)
            .select('*, clients(name, email, phone), properties(address, city, state)')
            .single();
        if (error) throw error;

        // Auto-invoice when appeal is won and savings_amount is present
        if (updates.status === 'won' && (updates.savings_amount || data.savings_amount)) {
            const invoiceResult = await autoInvoiceClient(data);
            if (invoiceResult) {
                data._invoice = invoiceResult;
            }
        }

        res.json(data);
    } catch (err) {
        console.error('[Appeals] PATCH error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/appeals/stats/pipeline
router.get('/stats/pipeline', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        const { data, error } = await supabaseAdmin
            .from('appeals')
            .select('status, estimated_savings, savings_amount, signature');
        if (error) throw error;

        const pipeline = {};
        let totalEstimatedSavings = 0;
        let signed = 0;

        for (const a of data) {
            pipeline[a.status] = (pipeline[a.status] || 0) + 1;
            totalEstimatedSavings += parseFloat(a.estimated_savings) || 0;
            if (a.signature) signed++;
        }

        res.json({
            pipeline,
            totalEstimatedSavings,
            totalFees: Math.round(totalEstimatedSavings * 0.20),
            signed,
            total: data.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
