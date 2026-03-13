/**
 * Property Data Fetcher — pulls data from Texas county appraisal district websites.
 * Primary: Bexar County (BCAD) via TrueAutomation
 * Adapter pattern for adding Harris, Travis, etc.
 */

const axios = require('axios');
const cheerio = require('cheerio');

// ===== PROPERTY TYPE NORMALIZATION =====
const PROPERTY_TYPE_MAP = {
    // Single Family Home
    'single family': 'Single Family Home', 'sfr': 'Single Family Home', 'single family home': 'Single Family Home',
    'single-family': 'Single Family Home', 'sf': 'Single Family Home', 'detached': 'Single Family Home',
    'single fam': 'Single Family Home', 'res - single': 'Single Family Home',
    // Townhouse / Condo
    'townhouse': 'Townhouse / Condo', 'townhome': 'Townhouse / Condo', 'condo': 'Townhouse / Condo',
    'condominium': 'Townhouse / Condo', 'attached': 'Townhouse / Condo', 'th': 'Townhouse / Condo',
    'patio home': 'Townhouse / Condo', 'zero lot': 'Townhouse / Condo',
    // Duplex / Triplex / Fourplex
    'duplex': 'Duplex / Triplex / Fourplex', 'triplex': 'Duplex / Triplex / Fourplex',
    'fourplex': 'Duplex / Triplex / Fourplex', 'quadplex': 'Duplex / Triplex / Fourplex',
    '2-4 units': 'Duplex / Triplex / Fourplex', 'small multi': 'Duplex / Triplex / Fourplex',
    // Multi-Family (5+ units)
    'apartment': 'Multi-Family (5+ units)', 'multi-family': 'Multi-Family (5+ units)',
    'multi family': 'Multi-Family (5+ units)', 'mf': 'Multi-Family (5+ units)',
    'multifamily': 'Multi-Family (5+ units)', 'apartments': 'Multi-Family (5+ units)',
    'apt': 'Multi-Family (5+ units)', '5+ units': 'Multi-Family (5+ units)',
    // Commercial
    'commercial': 'Commercial', 'industrial': 'Commercial', 'retail': 'Commercial',
    'office': 'Commercial', 'warehouse': 'Commercial', 'mixed use': 'Commercial',
    'com': 'Commercial', 'ind': 'Commercial',
    // Vacant Land
    'land': 'Vacant Land', 'vacant': 'Vacant Land', 'vacant land': 'Vacant Land',
    'lot': 'Vacant Land', 'acreage': 'Vacant Land', 'unimproved': 'Vacant Land',
};

function normalizePropertyType(rawType) {
    if (!rawType) return null;
    const lower = rawType.trim().toLowerCase();
    // Direct match
    if (PROPERTY_TYPE_MAP[lower]) return PROPERTY_TYPE_MAP[lower];
    // Partial match
    for (const [key, value] of Object.entries(PROPERTY_TYPE_MAP)) {
        if (lower.includes(key)) return value;
    }
    // Legacy "Residential" → default to Single Family Home
    if (lower === 'residential' || lower === 'res') return 'Single Family Home';
    return rawType; // Return as-is if no match
}

// ===== COUNTY ADAPTER REGISTRY =====
const countyAdapters = {};

function registerAdapter(county, adapter) {
    countyAdapters[county.toLowerCase()] = adapter;
}

function getAdapter(county) {
    return countyAdapters[(county || 'bexar').toLowerCase()] || null;
}

// ===== BEXAR COUNTY (BCAD) — TrueAutomation =====
const bcadAdapter = {
    name: 'Bexar County Appraisal District',
    code: 'BCAD',
    baseUrl: 'https://bexar.trueautomation.com/clientdb',

    async searchByAddress(address) {
        try {
            // TrueAutomation search
            const searchUrl = `${this.baseUrl}/PropertySearch.aspx`;

            // First GET to grab viewstate/session
            const sessionRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 15000
            });

            const $ = cheerio.load(sessionRes.data);
            const viewState = $('input[name="__VIEWSTATE"]').val() || '';
            const viewStateGen = $('input[name="__VIEWSTATEGENERATOR"]').val() || '';
            const eventValidation = $('input[name="__EVENTVALIDATION"]').val() || '';
            const cookies = (sessionRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

            // POST search form
            const formData = new URLSearchParams();
            formData.append('__VIEWSTATE', viewState);
            formData.append('__VIEWSTATEGENERATOR', viewStateGen);
            formData.append('__EVENTVALIDATION', eventValidation);
            formData.append('ctl00$ContentPlaceHolder1$TextBox_StreetName', this._extractStreetName(address));
            formData.append('ctl00$ContentPlaceHolder1$Button_Search', 'Search');

            const searchRes = await axios.post(searchUrl, formData.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Cookie': cookies,
                    'Referer': searchUrl
                },
                maxRedirects: 5,
                timeout: 15000
            });

            const $results = cheerio.load(searchRes.data);
            const properties = [];

            // Parse search results table
            $results('table.SearchResults tr, table#searchResults tr, tr.SearchResults').each((i, row) => {
                if (i === 0) return; // skip header
                const cells = $results(row).find('td');
                if (cells.length >= 3) {
                    const link = $results(row).find('a');
                    const href = link.attr('href') || '';
                    const accountId = link.text().trim() || cells.eq(0).text().trim();
                    const propAddress = cells.eq(1).text().trim();
                    const ownerName = cells.eq(2).text().trim();

                    if (accountId) {
                        properties.push({
                            accountId,
                            address: propAddress,
                            ownerName,
                            detailUrl: href ? `${this.baseUrl}/${href}` : null
                        });
                    }
                }
            });

            return properties;
        } catch (error) {
            console.error('[BCAD] Search failed:', error.message);
            return [];
        }
    },

    async getPropertyDetails(accountIdOrUrl) {
        try {
            let url = accountIdOrUrl;
            if (!url.startsWith('http')) {
                url = `${this.baseUrl}/Property.aspx?cid=110&prop_id=${accountIdOrUrl}`;
            }

            const res = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 15000
            });

            const $ = cheerio.load(res.data);
            const data = {
                source: 'BCAD',
                fetchedAt: new Date().toISOString(),
                accountId: this._getText($, 'Account', 'Prop ID', 'Property ID'),
                ownerName: this._getText($, 'Owner Name', 'Owner'),
                address: this._getText($, 'Property Address', 'Address', 'Situs'),
                legalDescription: this._getText($, 'Legal Description', 'Legal'),
                propertyType: normalizePropertyType(this._getText($, 'Property Type', 'Type', 'Improvement Type', 'State Category')),
                neighborhoodCode: this._getText($, 'Neighborhood', 'Nbhd', 'Map ID'),
                sqft: this._getNumeric($, 'Living Area', 'Square Feet', 'SqFt', 'Total Living Area', 'Heated Area'),
                yearBuilt: this._getNumeric($, 'Year Built', 'Yr Built', 'Year Blt'),
                bedrooms: this._getNumeric($, 'Bedrooms', 'Beds'),
                bathrooms: this._getNumeric($, 'Bathrooms', 'Baths', 'Full Baths'),
                lotSize: this._getNumeric($, 'Lot Size', 'Land Area', 'Acres', 'Land SqFt'),
                assessedValue: this._getNumeric($, 'Appraised Value', 'Total Value', 'Market Value', 'Assessed Value'),
                landValue: this._getNumeric($, 'Land Value', 'Land Appraised'),
                improvementValue: this._getNumeric($, 'Improvement Value', 'Impr Value', 'Impr Appraised'),
                exemptions: this._getText($, 'Exemptions', 'Exemption'),
                valueHistory: this._parseValueHistory($)
            };

            return data;
        } catch (error) {
            console.error('[BCAD] Detail fetch failed:', error.message);
            return null;
        }
    },

    async searchComparables(subject, options = {}) {
        // Try to search neighborhood for similar properties
        try {
            const street = this._extractStreetName(subject.address || '');
            if (!street) return [];

            // Search the same street/area
            const results = await this.searchByAddress(street);
            const details = [];

            // Fetch details for up to 20 results
            for (const prop of results.slice(0, 20)) {
                if (prop.detailUrl) {
                    const detail = await this.getPropertyDetails(prop.detailUrl);
                    if (detail && detail.assessedValue) {
                        details.push(detail);
                    }
                    // Be polite to the server
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            return details;
        } catch (error) {
            console.error('[BCAD] Comp search failed:', error.message);
            return [];
        }
    },

    // ===== HELPERS =====
    _extractStreetName(address) {
        // "1234 Main St, San Antonio TX 78201" → "Main"
        const cleaned = (address || '').replace(/,.*$/, '').trim();
        const parts = cleaned.split(/\s+/);
        // Remove house number (first part if numeric)
        if (parts.length > 1 && /^\d+$/.test(parts[0])) parts.shift();
        // Remove suffix (St, Dr, Ln, etc.)
        const suffixes = ['st', 'street', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'blvd', 'ave', 'avenue', 'rd', 'road', 'way', 'pl', 'place', 'cir', 'circle', 'pkwy', 'parkway'];
        if (parts.length > 1 && suffixes.includes(parts[parts.length - 1].toLowerCase())) parts.pop();
        return parts.join(' ');
    },

    _getText($, ...labels) {
        for (const label of labels) {
            // Try finding by label text in td, th, span, label
            const found = $(`td, th, span, label, div`).filter(function () {
                return $(this).text().trim().toLowerCase().includes(label.toLowerCase());
            });
            if (found.length) {
                const next = found.first().next();
                const text = next.text().trim();
                if (text && text !== label) return text;
                // Try parent's next sibling
                const parentNext = found.first().parent().next();
                const pText = parentNext.text().trim();
                if (pText) return pText;
            }
        }
        return null;
    },

    _getNumeric($, ...labels) {
        const text = this._getText($, ...labels);
        if (!text) return null;
        const num = parseFloat(text.replace(/[$,\s]/g, ''));
        return isNaN(num) ? null : num;
    },

    _parseValueHistory($) {
        const history = [];
        // Look for value history table
        $('table').each((_, table) => {
            const headerText = $(table).find('th, td').first().text().toLowerCase();
            if (headerText.includes('year') || headerText.includes('history')) {
                $(table).find('tr').each((i, row) => {
                    if (i === 0) return;
                    const cells = $(row).find('td');
                    if (cells.length >= 2) {
                        const year = parseInt(cells.eq(0).text().trim());
                        const value = parseFloat(cells.eq(1).text().replace(/[$,]/g, ''));
                        if (year && value) {
                            history.push({ year, value });
                        }
                    }
                });
            }
        });
        return history.length ? history : null;
    }
};

registerAdapter('bexar', bcadAdapter);

// ===== BIS CONSULTANTS E-SEARCH HELPER =====
// Shared by FBCAD and TCAD — same platform, different base URLs
function createBISAdapter({ name, code, baseUrl }) {
    return {
        name,
        code,
        baseUrl,

        _parseAddress(address) {
            const cleaned = (address || '').replace(/,.*$/, '').trim();
            const parts = cleaned.split(/\s+/);
            let streetNumber = '';
            let streetName = '';
            if (parts.length > 1 && /^\d+$/.test(parts[0])) {
                streetNumber = parts.shift();
            }
            // Remove common suffixes for search
            const suffixes = ['st', 'street', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'blvd', 'ave', 'avenue', 'rd', 'road', 'way', 'pl', 'place', 'cir', 'circle', 'pkwy', 'parkway'];
            if (parts.length > 1 && suffixes.includes(parts[parts.length - 1].toLowerCase())) parts.pop();
            streetName = parts.join(' ');
            return { streetNumber, streetName };
        },

        async searchByAddress(address) {
            try {
                const { streetNumber, streetName } = this._parseAddress(address);
                if (!streetName) return [];

                const currentYear = new Date().getFullYear();
                let keywords = `StreetName:${streetName} Year:${currentYear}`;
                if (streetNumber) keywords = `StreetNumber:${streetNumber} ${keywords}`;

                const searchUrl = `${this.baseUrl}/Search/Result?keywords=${encodeURIComponent(keywords)}`;
                console.log(`[${this.code}] Searching: ${searchUrl}`);

                const res = await axios.get(searchUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml'
                    },
                    timeout: 20000
                });

                const $ = cheerio.load(res.data);
                const properties = [];

                // BIS e-search returns a table with columns:
                // Quick Ref ID, Geo ID, Type, Owner Name, Owner ID, Situs Address, Appraised
                $('table tbody tr, table.table tr').each((i, row) => {
                    const cells = $(row).find('td');
                    if (cells.length < 6) return;

                    const quickRefId = cells.eq(0).text().trim();
                    const geoId = cells.eq(1).text().trim();
                    const type = cells.eq(2).text().trim();
                    const ownerName = cells.eq(3).text().trim();
                    const situsAddress = cells.eq(5).text().trim();
                    const appraised = cells.eq(6).text().trim();

                    if (!quickRefId || /quick\s*ref/i.test(quickRefId)) return; // skip header rows

                    const link = cells.eq(0).find('a');
                    const href = link.attr('href') || '';

                    properties.push({
                        accountId: quickRefId,
                        geoId,
                        address: situsAddress,
                        ownerName,
                        propertyType: type,
                        assessedValue: parseFloat((appraised || '0').replace(/[$,\s]/g, '')) || null,
                        detailUrl: href ? (href.startsWith('http') ? href : `${this.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`) : `${this.baseUrl}/Property/View/${quickRefId}`
                    });
                });

                console.log(`[${this.code}] Found ${properties.length} results`);
                return properties;
            } catch (error) {
                console.error(`[${this.code}] Search failed:`, error.message);
                return [];
            }
        },

        async getPropertyDetails(accountIdOrUrl) {
            try {
                let url = accountIdOrUrl;
                if (!url.startsWith('http')) {
                    url = `${this.baseUrl}/Property/View/${accountIdOrUrl}`;
                }

                console.log(`[${this.code}] Fetching details: ${url}`);

                const res = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml'
                    },
                    timeout: 20000
                });

                const $ = cheerio.load(res.data);

                // BIS detail pages use label/value pairs in various formats
                const getText = (...labels) => {
                    for (const label of labels) {
                        // Try table rows with th/td pairs
                        $('th, td, dt, label, span.label, strong').each(function () {
                            const el = $(this);
                            if (el.text().trim().toLowerCase().includes(label.toLowerCase())) {
                                const next = el.next();
                                const val = next.text().trim();
                                if (val && val.toLowerCase() !== label.toLowerCase()) {
                                    getText._result = val;
                                    return false; // break .each()
                                }
                                // Try parent's next sibling
                                const parentNext = el.parent().next();
                                const pVal = parentNext.text().trim();
                                if (pVal) {
                                    getText._result = pVal;
                                    return false;
                                }
                            }
                        });
                        if (getText._result) {
                            const r = getText._result;
                            getText._result = null;
                            return r;
                        }
                    }
                    return null;
                };
                getText._result = null;

                const getNumeric = (...labels) => {
                    const text = getText(...labels);
                    if (!text) return null;
                    const num = parseFloat(text.replace(/[$,\s]/g, ''));
                    return isNaN(num) ? null : num;
                };

                const data = {
                    source: this.code,
                    fetchedAt: new Date().toISOString(),
                    accountId: getText('Quick Ref', 'Account', 'Prop ID', 'Property ID') ||
                               accountIdOrUrl.replace(/.*\//, ''),
                    ownerName: getText('Owner Name', 'Owner'),
                    address: getText('Situs Address', 'Address', 'Property Address', 'Situs'),
                    legalDescription: getText('Legal Description', 'Legal'),
                    propertyType: normalizePropertyType(getText('Type', 'Property Type', 'State Category', 'Improvement Type')),
                    neighborhoodCode: getText('Neighborhood', 'Nbhd', 'Map ID'),
                    sqft: getNumeric('Living Area', 'Square Feet', 'SqFt', 'Total Living Area', 'Heated Area', 'GLA'),
                    yearBuilt: getNumeric('Year Built', 'Yr Built', 'Year Blt'),
                    bedrooms: getNumeric('Bedrooms', 'Beds'),
                    bathrooms: getNumeric('Bathrooms', 'Baths', 'Full Baths'),
                    lotSize: getNumeric('Lot Size', 'Land Area', 'Acres', 'Land SqFt'),
                    assessedValue: getNumeric('Appraised Value', 'Total Value', 'Market Value', 'Assessed Value', 'Total Appraised'),
                    landValue: getNumeric('Land Value', 'Land Appraised', 'Land Market'),
                    improvementValue: getNumeric('Improvement Value', 'Impr Value', 'Impr Appraised', 'Improvement Market'),
                    exemptions: getText('Exemptions', 'Exemption'),
                    valueHistory: this._parseValueHistory($)
                };

                return data;
            } catch (error) {
                console.error(`[${this.code}] Detail fetch failed:`, error.message);
                return null;
            }
        },

        async searchComparables(subject) {
            // Comps come from comp-engine.js; return empty
            return [];
        },

        _parseValueHistory($) {
            const history = [];
            $('table').each((_, table) => {
                const headerText = $(table).find('th, td').first().text().toLowerCase();
                if (headerText.includes('year') || headerText.includes('history') || headerText.includes('value')) {
                    $(table).find('tr').each((i, row) => {
                        if (i === 0) return;
                        const cells = $(row).find('td');
                        if (cells.length >= 2) {
                            const year = parseInt(cells.eq(0).text().trim());
                            const value = parseFloat(cells.eq(1).text().replace(/[$,]/g, ''));
                            if (year && value) history.push({ year, value });
                        }
                    });
                }
            });
            return history.length ? history : null;
        }
    };
}

// ===== FORT BEND COUNTY (FBCAD) — BIS e-search =====
registerAdapter('fort bend', createBISAdapter({
    name: 'Fort Bend Central Appraisal District',
    code: 'FBCAD',
    baseUrl: 'https://esearch.fbcad.org'
}));

// ===== TRAVIS COUNTY (TCAD) — BIS e-search =====
registerAdapter('travis', createBISAdapter({
    name: 'Travis Central Appraisal District',
    code: 'TCAD',
    baseUrl: 'https://esearch.austincad.org'
}));

// ===== HARRIS COUNTY (HCAD) =====
registerAdapter('harris', {
    name: 'Harris County Appraisal District',
    code: 'HCAD',
    baseUrl: 'https://public.hcad.org',

    _parseAddress(address) {
        const cleaned = (address || '').replace(/,.*$/, '').trim();
        const parts = cleaned.split(/\s+/);
        let streetNumber = '';
        if (parts.length > 1 && /^\d+$/.test(parts[0])) {
            streetNumber = parts.shift();
        }
        const suffixes = ['st', 'street', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'blvd', 'ave', 'avenue', 'rd', 'road', 'way', 'pl', 'place', 'cir', 'circle', 'pkwy', 'parkway'];
        if (parts.length > 1 && suffixes.includes(parts[parts.length - 1].toLowerCase())) parts.pop();
        return { streetNumber, streetName: parts.join(' ') };
    },

    async searchByAddress(address) {
        // HCAD's public site is unreliable. Try the public search, fall back gracefully.
        try {
            const { streetNumber, streetName } = this._parseAddress(address);
            if (!streetName) return [];

            // Try HCAD's public property search
            const searchUrl = `https://public.hcad.org/records/Real.asp?search=addr&stnum=${encodeURIComponent(streetNumber)}&stname=${encodeURIComponent(streetName)}&sttype=&stsfx=`;
            console.log(`[HCAD] Searching: ${searchUrl}`);

            const res = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml'
                },
                timeout: 20000,
                maxRedirects: 5
            });

            const $ = cheerio.load(res.data);
            const properties = [];

            // HCAD returns results in a table
            $('table tr').each((i, row) => {
                if (i === 0) return; // skip header
                const cells = $(row).find('td');
                if (cells.length < 3) return;

                const link = $(row).find('a');
                const href = link.attr('href') || '';
                const accountId = link.text().trim() || cells.eq(0).text().trim();
                const propAddress = cells.eq(1).text().trim();
                const ownerName = cells.eq(2).text().trim();

                if (accountId && !/account/i.test(accountId)) {
                    properties.push({
                        accountId,
                        address: propAddress,
                        ownerName,
                        detailUrl: href ? (href.startsWith('http') ? href : `https://public.hcad.org/records/${href}`) : null
                    });
                }
            });

            console.log(`[HCAD] Found ${properties.length} results`);
            return properties;
        } catch (error) {
            console.error(`[HCAD] Search failed (site may be down):`, error.message);
            return [];
        }
    },

    async getPropertyDetails(accountIdOrUrl) {
        try {
            let url = accountIdOrUrl;
            if (!url.startsWith('http')) {
                url = `https://public.hcad.org/records/details.asp?cession=A&theession=${accountIdOrUrl}`;
            }

            console.log(`[HCAD] Fetching details: ${url}`);

            const res = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml'
                },
                timeout: 20000,
                maxRedirects: 5
            });

            const $ = cheerio.load(res.data);

            const getText = (...labels) => {
                for (const label of labels) {
                    const found = $('td, th, span, label, div, font').filter(function () {
                        return $(this).text().trim().toLowerCase().includes(label.toLowerCase());
                    });
                    if (found.length) {
                        const next = found.first().next();
                        const text = next.text().trim();
                        if (text && text.toLowerCase() !== label.toLowerCase()) return text;
                        const parentNext = found.first().parent().next();
                        const pText = parentNext.text().trim();
                        if (pText) return pText;
                    }
                }
                return null;
            };

            const getNumeric = (...labels) => {
                const text = getText(...labels);
                if (!text) return null;
                const num = parseFloat(text.replace(/[$,\s]/g, ''));
                return isNaN(num) ? null : num;
            };

            return {
                source: 'HCAD',
                fetchedAt: new Date().toISOString(),
                accountId: getText('Account', 'Account Number') || accountIdOrUrl.replace(/.*=/, ''),
                ownerName: getText('Owner Name', 'Owner'),
                address: getText('Property Address', 'Address', 'Site Address'),
                legalDescription: getText('Legal Description', 'Legal'),
                propertyType: normalizePropertyType(getText('State Class', 'Type', 'Property Type', 'Building Type')),
                neighborhoodCode: getText('Neighborhood', 'Nbhd'),
                sqft: getNumeric('Building Area', 'Living Area', 'Square Feet', 'Total Area'),
                yearBuilt: getNumeric('Year Built', 'Yr Built'),
                bedrooms: getNumeric('Bedrooms', 'Beds'),
                bathrooms: getNumeric('Bathrooms', 'Baths'),
                lotSize: getNumeric('Lot Size', 'Land Area', 'Land Size'),
                assessedValue: getNumeric('Appraised Value', 'Total Value', 'Total Appraised', 'Market Value'),
                landValue: getNumeric('Land Value', 'Land Appraised'),
                improvementValue: getNumeric('Improvement Value', 'Impr Value', 'Bldg Value'),
                exemptions: getText('Exemptions', 'Exemption'),
                valueHistory: null // HCAD detail pages don't reliably show history
            };
        } catch (error) {
            console.error(`[HCAD] Detail fetch failed (site may be down):`, error.message);
            return null;
        }
    },

    async searchComparables(subject) {
        // Comps come from comp-engine.js; return empty
        return [];
    }
});

// ===== MAIN API =====

/**
 * Detect county from address (default: Bexar)
 */
function detectCounty(address) {
    const addr = (address || '').toLowerCase();
    if (addr.includes('houston') || addr.includes('harris')) return 'harris';
    if (addr.includes('austin') || addr.includes('travis') || addr.includes('pflugerville') || addr.includes('round rock') || addr.includes('cedar park')) return 'travis';
    if (addr.includes('fort bend') || addr.includes('richmond') || addr.includes('sugar land') || addr.includes('sugarland') || addr.includes('katy') || addr.includes('missouri city') || addr.includes('rosenberg') || addr.includes('stafford') || addr.includes('fulshear')) return 'fort bend';
    return 'bexar'; // Default for San Antonio area
}

/**
 * Fetch property data for a case
 */
async function fetchPropertyData(caseData) {
    const county = detectCounty(caseData.propertyAddress);
    const adapter = getAdapter(county);
    if (!adapter) throw new Error(`No adapter for county: ${county}`);

    console.log(`[PropertyData] Fetching from ${adapter.name} for: ${caseData.propertyAddress}`);

    // Try scraping first
    let propertyData = null;
    try {
        const results = await adapter.searchByAddress(caseData.propertyAddress);
        if (results.length > 0 && results[0].detailUrl) {
            propertyData = await adapter.getPropertyDetails(results[0].detailUrl);
        } else if (results.length > 0 && results[0].accountId) {
            propertyData = await adapter.getPropertyDetails(results[0].accountId);
        }
    } catch (err) {
        console.error(`[PropertyData] Scrape failed: ${err.message}`);
    }

    // Fallback: build from case data + reasonable estimates
    if (!propertyData || !propertyData.assessedValue) {
        console.log('[PropertyData] Using fallback data from case intake');
        const assessedNum = parseInt((caseData.assessedValue || '0').replace(/[^0-9]/g, '')) || 300000;
        propertyData = {
            source: 'intake-fallback',
            fetchedAt: new Date().toISOString(),
            accountId: caseData.pin || null,
            ownerName: caseData.ownerName,
            address: caseData.propertyAddress,
            legalDescription: null,
            propertyType: normalizePropertyType(caseData.propertyType) || 'Single Family Home',
            neighborhoodCode: null,
            sqft: caseData.sqft ? parseInt(caseData.sqft) : null,
            yearBuilt: caseData.yearBuilt ? parseInt(caseData.yearBuilt) : null,
            bedrooms: caseData.bedrooms ? parseInt(caseData.bedrooms) : null,
            bathrooms: caseData.bathrooms ? parseFloat(caseData.bathrooms) : null,
            lotSize: null,
            assessedValue: assessedNum,
            landValue: Math.round(assessedNum * 0.25),
            improvementValue: Math.round(assessedNum * 0.75),
            exemptions: null,
            valueHistory: _generateEstimatedHistory(assessedNum)
        };
    }

    // Ensure value history exists
    if (!propertyData.valueHistory || propertyData.valueHistory.length === 0) {
        propertyData.valueHistory = _generateEstimatedHistory(propertyData.assessedValue);
    }

    return propertyData;
}

function _generateEstimatedHistory(currentValue) {
    const currentYear = new Date().getFullYear();
    const history = [];
    let val = currentValue;
    for (let i = 0; i < 5; i++) {
        history.push({ year: currentYear - i, value: Math.round(val) });
        val = val / (1 + (0.05 + Math.random() * 0.05)); // ~5-10% annual increase backward
    }
    return history;
}

module.exports = {
    fetchPropertyData,
    detectCounty,
    getAdapter,
    registerAdapter,
    countyAdapters,
    normalizePropertyType
};
