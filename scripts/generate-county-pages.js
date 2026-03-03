const fs = require('fs');
const path = require('path');
const countyData = require('./county-data');

// Read the Bexar County template
const templatePath = path.join(__dirname, '..', 'lp', 'bexar-county.html');
const template = fs.readFileSync(templatePath, 'utf8');

function generateCountyPage(countyKey, data) {
  let content = template;
  
  // Replace all Bexar-specific content
  content = content.replace(/Bexar County/g, data.fullName);
  content = content.replace(/Bexar/g, data.name);
  content = content.replace(/San Antonio/g, data.majorCity);
  content = content.replace(/BCAD/g, `${data.name}CAD`);
  content = content.replace(/Bexar County Appraisal District/g, data.cadName);
  
  // Update meta tags
  content = content.replace(
    /Bexar County property tax too high\? San Antonio experts fight BCAD assessments\./g,
    `${data.fullName} property tax too high? ${data.majorCity} experts fight ${data.name}CAD assessments.`
  );
  
  // Update canonical URL
  content = content.replace(
    /https:\/\/overassessed\.ai\/bexar-county/g,
    `https://overassessed.ai/lp/${countyKey}-county`
  );
  
  // Update title tags
  content = content.replace(
    /Bexar County Property Tax Protest \| OverAssessed — BCAD Experts/g,
    `${data.fullName} Property Tax Protest | OverAssessed — ${data.name}CAD Experts`
  );
  
  // Update hero section
  content = content.replace(
    /<h1>Fight Your.*?<\/h1>/s,
    `<h1>Fight Your ${data.fullName} Property Tax Assessment</h1>`
  );
  
  // Update stats (these will be approximate)
  content = content.replace(/\$4[0-9][0-9],000/g, data.medianHomeValue);
  content = content.replace(/2\.[0-9][0-9]%/g, data.avgTaxRate);
  content = content.replace(/1,986,049/g, data.population);
  
  // Update neighborhoods in testimonials/content
  const neighborhoods = data.neighborhoods.join(', ');
  content = content.replace(
    /Stone Oak, Alamo Heights, Helotes, Boerne, Fair Oaks Ranch/g,
    neighborhoods
  );
  
  // Update CAD contact info
  content = content.replace(
    /210-242-2000/g,
    data.cadPhone
  );
  content = content.replace(
    /bcad\.org/g,
    data.cadWebsite
  );
  
  return content;
}

// Generate all missing county pages
const missingCounties = ['comal', 'guadalupe', 'hays', 'williamson', 'collin', 'denton', 'fort-bend', 'montgomery', 'el-paso', 'hidalgo'];

missingCounties.forEach(countyKey => {
  const data = countyData[countyKey];
  if (!data) {
    console.log(`No data found for ${countyKey}`);
    return;
  }
  
  const content = generateCountyPage(countyKey, data);
  const outputPath = path.join(__dirname, '..', 'lp', `${countyKey}-county.html`);
  
  fs.writeFileSync(outputPath, content, 'utf8');
  console.log(`Generated: ${countyKey}-county.html`);
});

console.log('All county pages generated!');
