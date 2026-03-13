/**
 * RentCast API Integration
 * Provides AVM (Automated Valuation Model) and property data from RentCast,
 * combined with Bexar County ArcGIS parcel data.
 */

const axios = require('axios');

const { detectCounty } = require('./property-data');

const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const ARCGIS_BASE = 'https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query';

// County-specific tax rates
const COUNTY_TAX_RATES = {
    'bexar': 0.0225,
    'harris': 0.0230,
    'travis': 0.0210,
    'fort bend': 0.0250
};

function getTaxRate(county) {
    return COUNTY_TAX_RATES[(county || 'bexar').toLowerCase()] || 0.0225;
}

function getApiKey() {
    const key = process.env.RENTCAST_API_KEY;
    if (!key) throw new Error('RENTCAST_API_KEY not set');
    return key;
}

const rcHeaders = () => ({
    'Accept': 'application/json',
    'X-Api-Key': getApiKey()
});

// ── RentCast AVM ──────────────────────────────────────────
async function getAVM(address) {
    const { data } = await axios.get(`${RENTCAST_BASE}/avm/value`, {
        params: { address },
        headers: rcHeaders(),
        timeout: 15000
    });
    return data;
}

// ── RentCast Property Lookup ──────────────────────────────
async function getProperty(address) {
    const { data } = await axios.get(`${RENTCAST_BASE}/properties`, {
        params: { address },
        headers: rcHeaders(),
        timeout: 15000
    });
    // API returns array; take first match
    return Array.isArray(data) ? data[0] || null : data;
}

// ── Bexar County ArcGIS Parcel Query ──────────────────────
async function getBexarParcel(address) {
    try {
        // Normalise: strip unit/apt, uppercase
        const clean = address.replace(/,?\s*(san antonio|sa|tx|texas|\d{5}(-\d{4})?)/gi, '').trim().toUpperCase();
        const { data } = await axios.get(ARCGIS_BASE, {
            params: {
                where: `SitusAddress LIKE '%${clean.replace(/'/g, "''")}%'`,
                outFields: 'PropID,SitusAddress,TotVal,LandVal,ImprVal,YrBlt,GBA,OwnerName,LegalDesc,PropertyType',
                returnGeometry: false,
                f: 'json'
            },
            timeout: 15000
        });
        if (data.features && data.features.length > 0) {
            return data.features[0].attributes;
        }
        return null;
    } catch (err) {
        console.error('[ArcGIS] Query failed:', err.message);
        return null;
    }
}

// ── Combined Analysis ─────────────────────────────────────
async function runRentCastAnalysis(address, propertyDataFallback = null) {
    const county = detectCounty(address);
    const taxRate = getTaxRate(county);

    // Fire all three in parallel
    const [avm, property, parcel] = await Promise.allSettled([
        getAVM(address),
        getProperty(address),
        getBexarParcel(address)
    ]);

    const avmData = avm.status === 'fulfilled' ? avm.value : null;
    const propData = property.status === 'fulfilled' ? property.value : null;
    const parcelData = parcel.status === 'fulfilled' ? parcel.value : null;

    // If AVM returned no data, use property data adapter as fallback instead of throwing
    if (!avmData) {
        console.log('[RentCast] AVM returned no data — using property data fallback');
        if (!propertyDataFallback) {
            // Return a degraded result instead of throwing
            return {
                address,
                rentcast: {
                    marketValue: null, marketLow: null, marketHigh: null,
                    confidence: null, comparables: [],
                    propertyType: (propData && propData.propertyType) || null,
                    squareFootage: (propData && propData.squareFootage) || null,
                    yearBuilt: (propData && propData.yearBuilt) || null,
                    bedrooms: (propData && propData.bedrooms) || null,
                    bathrooms: (propData && propData.bathrooms) || null
                },
                county: parcelData ? {
                    propId: parcelData.PropID, assessedValue: parcelData.TotVal,
                    landValue: parcelData.LandVal, improvementValue: parcelData.ImprVal,
                    yearBuilt: parcelData.YrBlt, gba: parcelData.GBA,
                    ownerName: parcelData.OwnerName, legalDesc: parcelData.LegalDesc,
                    propertyType: parcelData.PropertyType
                } : null,
                analysis: {
                    overAssessmentAmount: null, overAssessmentPct: null,
                    recommendation: 'insufficient_data',
                    estimatedTaxSavings: 0,
                    note: 'RentCast AVM returned no data. Analysis based on county records only.'
                }
            };
        }
    }

    const marketValue = avmData ? (avmData.price || avmData.priceRangeLow || 0)
        : (propertyDataFallback ? propertyDataFallback.assessedValue : 0);
    const marketLow = avmData ? (avmData.priceRangeLow || marketValue) : marketValue;
    const marketHigh = avmData ? (avmData.priceRangeHigh || marketValue) : marketValue;

    // County assessed value — try parcel data first, then property data fallback
    const assessedValue = parcelData ? (parcelData.TotVal || 0)
        : (propertyDataFallback ? propertyDataFallback.assessedValue : null);

    // Over-assessment
    const overAssessment = assessedValue != null && marketValue ? assessedValue - marketValue : null;
    const overPct = assessedValue && marketValue ? ((assessedValue - marketValue) / marketValue * 100) : null;

    // Protest recommendation
    let recommendation = 'weak';
    if (overPct !== null) {
        if (overPct >= 30) recommendation = 'strong';
        else if (overPct >= 10) recommendation = 'moderate';
    }

    // Comparables from AVM response
    const comps = (avmData ? (avmData.comparables || []) : []).map(c => ({
        address: c.formattedAddress || c.address || 'N/A',
        price: c.price || c.lastSalePrice || null,
        sqft: c.squareFootage || null,
        yearBuilt: c.yearBuilt || null,
        bedrooms: c.bedrooms || null,
        bathrooms: c.bathrooms || null,
        lotSize: c.lotSize || null,
        lastSaleDate: c.lastSaleDate || null,
        correlation: c.correlation || c.score || null,
        distance: c.distance || null,
        propertyType: c.propertyType || null
    }));

    // Build fallback property info from adapter if RentCast property lookup also failed
    const fbProp = propertyDataFallback || {};

    return {
        address,
        rentcast: {
            marketValue,
            marketLow,
            marketHigh,
            confidence: avmData ? (avmData.confidence || null) : null,
            comparables: comps,
            propertyType: (avmData && avmData.propertyType) || (propData && propData.propertyType) || fbProp.propertyType || null,
            squareFootage: (avmData && avmData.squareFootage) || (propData && propData.squareFootage) || fbProp.sqft || null,
            yearBuilt: (avmData && avmData.yearBuilt) || (propData && propData.yearBuilt) || fbProp.yearBuilt || null,
            bedrooms: (avmData && avmData.bedrooms) || (propData && propData.bedrooms) || fbProp.bedrooms || null,
            bathrooms: (avmData && avmData.bathrooms) || (propData && propData.bathrooms) || fbProp.bathrooms || null
        },
        county: parcelData ? {
            propId: parcelData.PropID,
            assessedValue: parcelData.TotVal,
            landValue: parcelData.LandVal,
            improvementValue: parcelData.ImprVal,
            yearBuilt: parcelData.YrBlt,
            gba: parcelData.GBA,
            ownerName: parcelData.OwnerName,
            legalDesc: parcelData.LegalDesc,
            propertyType: parcelData.PropertyType
        } : (propertyDataFallback ? {
            propId: propertyDataFallback.accountId,
            assessedValue: propertyDataFallback.assessedValue,
            landValue: propertyDataFallback.landValue,
            improvementValue: propertyDataFallback.improvementValue,
            yearBuilt: propertyDataFallback.yearBuilt,
            gba: propertyDataFallback.sqft,
            ownerName: propertyDataFallback.ownerName,
            legalDesc: propertyDataFallback.legalDescription,
            propertyType: propertyDataFallback.propertyType
        } : null),
        analysis: {
            overAssessmentAmount: overAssessment,
            overAssessmentPct: overPct != null ? Math.round(overPct * 10) / 10 : null,
            recommendation,
            estimatedTaxSavings: overAssessment > 0 ? Math.round(overAssessment * taxRate) : 0,
            taxRate,
            county
        }
    };
}

// ── Comps-Only ────────────────────────────────────────────
async function getComps(address) {
    const avmData = await getAVM(address);
    return (avmData.comparables || []).map(c => ({
        address: c.formattedAddress || c.address || 'N/A',
        price: c.price || c.lastSalePrice || null,
        sqft: c.squareFootage || null,
        yearBuilt: c.yearBuilt || null,
        bedrooms: c.bedrooms || null,
        bathrooms: c.bathrooms || null,
        lastSaleDate: c.lastSaleDate || null,
        correlation: c.correlation || c.score || null,
        distance: c.distance || null,
        propertyType: c.propertyType || null
    }));
}

module.exports = { runRentCastAnalysis, getComps, getAVM, getProperty, getBexarParcel, getTaxRate, COUNTY_TAX_RATES };
