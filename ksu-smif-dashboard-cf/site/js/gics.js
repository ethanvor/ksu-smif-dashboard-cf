// GICS classification helpers.
// Held stocks use the fund workbook's GICS columns. For other tickers we map Yahoo Finance's
// industry name to the closest GICS industry (Yahoo uses its own, Morningstar-style categories).

// The workbook export cuts industry names at 30 characters; restore the full GICS names.
const FULL = {
  'Electronic Equipment, Instrume': 'Electronic Equipment, Instruments & Components',
  'Semiconductors & Semiconductor': 'Semiconductors & Semiconductor Equipment',
  'Technology Hardware, Storage &': 'Technology Hardware, Storage & Peripherals',
  'Trading Companies & Distributo': 'Trading Companies & Distributors',
  'Hotels, Restaurants & Leisure': 'Hotels, Restaurants & Leisure',
  'Health Care Equipment & Suppli': 'Health Care Equipment & Supplies',
  'Health Care Providers & Servic': 'Health Care Providers & Services',
  'Diversified Telecommunication': 'Diversified Telecommunication Services',
  'Independent Power and Renewabl': 'Independent Power and Renewable Electricity Producers',
  'Real Estate Management & Devel': 'Real Estate Management & Development',
  'Commercial Services & Supplies': 'Commercial Services & Supplies',
  'Energy Equipment & Services': 'Energy Equipment & Services',
  'Textiles, Apparel & Luxury Goo': 'Textiles, Apparel & Luxury Goods',
  'Wireless Telecommunication Ser': 'Wireless Telecommunication Services',
  'Diversified Consumer Services': 'Diversified Consumer Services',
  'Professional Services': 'Professional Services',
};
export const fullIndustry = (s) => FULL[s] || s || '';

// GICS industry → GICS sector
const SECTOR_OF = {};
const add = (sector, list) => list.forEach((i) => (SECTOR_OF[i] = sector));
add('Energy', ['Energy Equipment & Services', 'Oil, Gas & Consumable Fuels']);
add('Materials', ['Chemicals', 'Construction Materials', 'Containers & Packaging', 'Metals & Mining', 'Paper & Forest Products']);
add('Industrials', ['Aerospace & Defense', 'Building Products', 'Construction & Engineering', 'Electrical Equipment', 'Industrial Conglomerates', 'Machinery', 'Trading Companies & Distributors', 'Commercial Services & Supplies', 'Professional Services', 'Air Freight & Logistics', 'Passenger Airlines', 'Marine Transportation', 'Ground Transportation', 'Transportation Infrastructure']);
add('Consumer Discretionary', ['Automobile Components', 'Automobiles', 'Household Durables', 'Leisure Products', 'Textiles, Apparel & Luxury Goods', 'Hotels, Restaurants & Leisure', 'Diversified Consumer Services', 'Distributors', 'Broadline Retail', 'Specialty Retail']);
add('Consumer Staples', ['Consumer Staples Distribution & Retail', 'Consumer Staples Distribution', 'Beverages', 'Food Products', 'Tobacco', 'Household Products', 'Personal Care Products']);
add('Health Care', ['Health Care Equipment & Supplies', 'Health Care Providers & Services', 'Health Care Technology', 'Biotechnology', 'Pharmaceuticals', 'Life Sciences Tools & Services']);
add('Financials', ['Banks', 'Financial Services', 'Consumer Finance', 'Capital Markets', 'Mortgage Real Estate Investment Trusts (REITs)', 'Insurance']);
add('Information Technology', ['IT Services', 'Software', 'Communications Equipment', 'Technology Hardware, Storage & Peripherals', 'Electronic Equipment, Instruments & Components', 'Semiconductors & Semiconductor Equipment']);
add('Communication Services', ['Diversified Telecommunication Services', 'Wireless Telecommunication Services', 'Media', 'Entertainment', 'Interactive Media & Services']);
add('Utilities', ['Electric Utilities', 'Gas Utilities', 'Multi-Utilities', 'Water Utilities', 'Independent Power and Renewable Electricity Producers']);
add('Real Estate', ['Diversified REITs', 'Industrial REITs', 'Hotel & Resort REITs', 'Office REITs', 'Health Care REITs', 'Residential REITs', 'Retail REITs', 'Specialized REITs', 'Real Estate Management & Development']);
export const sectorOfIndustry = (i) => SECTOR_OF[fullIndustry(i)] || null;

// Yahoo industry → GICS industry
const Y = {
  // Technology
  'Software - Application': 'Software', 'Software - Infrastructure': 'Software', 'Information Technology Services': 'IT Services',
  'Semiconductors': 'Semiconductors & Semiconductor Equipment', 'Semiconductor Equipment & Materials': 'Semiconductors & Semiconductor Equipment',
  'Consumer Electronics': 'Technology Hardware, Storage & Peripherals', 'Computer Hardware': 'Technology Hardware, Storage & Peripherals',
  'Communication Equipment': 'Communications Equipment', 'Electronic Components': 'Electronic Equipment, Instruments & Components',
  'Scientific & Technical Instruments': 'Electronic Equipment, Instruments & Components', 'Electronics & Computer Distribution': 'Electronic Equipment, Instruments & Components',
  'Solar': 'Semiconductors & Semiconductor Equipment',
  // Communication services
  'Internet Content & Information': 'Interactive Media & Services', 'Entertainment': 'Entertainment', 'Electronic Gaming & Multimedia': 'Entertainment',
  'Telecom Services': 'Diversified Telecommunication Services', 'Advertising Agencies': 'Media', 'Broadcasting': 'Media', 'Publishing': 'Media',
  // Consumer cyclical
  'Internet Retail': 'Broadline Retail', 'Department Stores': 'Broadline Retail', 'Specialty Retail': 'Specialty Retail', 'Home Improvement Retail': 'Specialty Retail',
  'Apparel Retail': 'Specialty Retail', 'Auto & Truck Dealerships': 'Specialty Retail', 'Luxury Goods': 'Textiles, Apparel & Luxury Goods',
  'Apparel Manufacturing': 'Textiles, Apparel & Luxury Goods', 'Footwear & Accessories': 'Textiles, Apparel & Luxury Goods', 'Textile Manufacturing': 'Textiles, Apparel & Luxury Goods',
  'Auto Manufacturers': 'Automobiles', 'Recreational Vehicles': 'Automobiles', 'Auto Parts': 'Automobile Components',
  'Restaurants': 'Hotels, Restaurants & Leisure', 'Lodging': 'Hotels, Restaurants & Leisure', 'Resorts & Casinos': 'Hotels, Restaurants & Leisure',
  'Gambling': 'Hotels, Restaurants & Leisure', 'Travel Services': 'Hotels, Restaurants & Leisure', 'Leisure': 'Leisure Products',
  'Residential Construction': 'Household Durables', 'Furnishings, Fixtures & Appliances': 'Household Durables', 'Packaging & Containers': 'Containers & Packaging',
  'Personal Services': 'Diversified Consumer Services', 'Education & Training Services': 'Diversified Consumer Services',
  // Consumer defensive
  'Discount Stores': 'Consumer Staples Distribution & Retail', 'Grocery Stores': 'Consumer Staples Distribution & Retail', 'Food Distribution': 'Consumer Staples Distribution & Retail',
  'Beverages - Non-Alcoholic': 'Beverages', 'Beverages - Brewers': 'Beverages', 'Beverages - Wineries & Distilleries': 'Beverages',
  'Packaged Foods': 'Food Products', 'Confectioners': 'Food Products', 'Farm Products': 'Food Products', 'Tobacco': 'Tobacco',
  'Household & Personal Products': 'Household Products',
  // Health care
  'Drug Manufacturers - General': 'Pharmaceuticals', 'Drug Manufacturers - Specialty & Generic': 'Pharmaceuticals', 'Biotechnology': 'Biotechnology',
  'Medical Devices': 'Health Care Equipment & Supplies', 'Medical Instruments & Supplies': 'Health Care Equipment & Supplies',
  'Diagnostics & Research': 'Life Sciences Tools & Services', 'Healthcare Plans': 'Health Care Providers & Services', 'Medical Care Facilities': 'Health Care Providers & Services',
  'Medical Distribution': 'Health Care Providers & Services', 'Pharmaceutical Retailers': 'Consumer Staples Distribution & Retail', 'Health Information Services': 'Health Care Technology',
  // Financials
  'Banks - Diversified': 'Banks', 'Banks - Regional': 'Banks', 'Credit Services': 'Financial Services', 'Financial Conglomerates': 'Financial Services',
  'Mortgage Finance': 'Financial Services', 'Asset Management': 'Capital Markets', 'Capital Markets': 'Capital Markets', 'Financial Data & Stock Exchanges': 'Capital Markets',
  'Insurance - Diversified': 'Insurance', 'Insurance - Life': 'Insurance', 'Insurance - Property & Casualty': 'Insurance', 'Insurance - Reinsurance': 'Insurance',
  'Insurance - Specialty': 'Insurance', 'Insurance Brokers': 'Insurance', 'Shell Companies': 'Financial Services',
  // Industrials
  'Aerospace & Defense': 'Aerospace & Defense', 'Specialty Industrial Machinery': 'Machinery', 'Farm & Heavy Construction Machinery': 'Machinery',
  'Tools & Accessories': 'Machinery', 'Metal Fabrication': 'Machinery', 'Electrical Equipment & Parts': 'Electrical Equipment', 'Conglomerates': 'Industrial Conglomerates',
  'Industrial Distribution': 'Trading Companies & Distributors', 'Rental & Leasing Services': 'Trading Companies & Distributors',
  'Building Products & Equipment': 'Building Products', 'Engineering & Construction': 'Construction & Engineering', 'Infrastructure Operations': 'Construction & Engineering',
  'Railroads': 'Ground Transportation', 'Trucking': 'Ground Transportation', 'Airlines': 'Passenger Airlines', 'Airports & Air Services': 'Transportation Infrastructure',
  'Integrated Freight & Logistics': 'Air Freight & Logistics', 'Marine Shipping': 'Marine Transportation',
  'Waste Management': 'Commercial Services & Supplies', 'Security & Protection Services': 'Commercial Services & Supplies', 'Business Equipment & Supplies': 'Commercial Services & Supplies',
  'Pollution & Treatment Controls': 'Commercial Services & Supplies', 'Specialty Business Services': 'Commercial Services & Supplies',
  'Consulting Services': 'Professional Services', 'Staffing & Employment Services': 'Professional Services',
  // Energy
  'Oil & Gas Integrated': 'Oil, Gas & Consumable Fuels', 'Oil & Gas E&P': 'Oil, Gas & Consumable Fuels', 'Oil & Gas Midstream': 'Oil, Gas & Consumable Fuels',
  'Oil & Gas Refining & Marketing': 'Oil, Gas & Consumable Fuels', 'Thermal Coal': 'Oil, Gas & Consumable Fuels', 'Uranium': 'Oil, Gas & Consumable Fuels',
  'Oil & Gas Equipment & Services': 'Energy Equipment & Services', 'Oil & Gas Drilling': 'Energy Equipment & Services',
  // Materials
  'Specialty Chemicals': 'Chemicals', 'Chemicals': 'Chemicals', 'Agricultural Inputs': 'Chemicals', 'Building Materials': 'Construction Materials',
  'Copper': 'Metals & Mining', 'Gold': 'Metals & Mining', 'Silver': 'Metals & Mining', 'Steel': 'Metals & Mining', 'Aluminum': 'Metals & Mining',
  'Other Industrial Metals & Mining': 'Metals & Mining', 'Other Precious Metals & Mining': 'Metals & Mining', 'Coking Coal': 'Metals & Mining',
  'Lumber & Wood Production': 'Paper & Forest Products', 'Paper & Paper Products': 'Paper & Forest Products',
  // Utilities
  'Utilities - Regulated Electric': 'Electric Utilities', 'Utilities - Regulated Gas': 'Gas Utilities', 'Utilities - Regulated Water': 'Water Utilities',
  'Utilities - Diversified': 'Multi-Utilities', 'Utilities - Independent Power Producers': 'Independent Power and Renewable Electricity Producers',
  'Utilities - Renewable': 'Independent Power and Renewable Electricity Producers',
  // Real estate
  'REIT - Diversified': 'Diversified REITs', 'REIT - Industrial': 'Industrial REITs', 'REIT - Hotel & Motel': 'Hotel & Resort REITs', 'REIT - Office': 'Office REITs',
  'REIT - Healthcare Facilities': 'Health Care REITs', 'REIT - Residential': 'Residential REITs', 'REIT - Retail': 'Retail REITs', 'REIT - Specialty': 'Specialized REITs',
  'REIT - Mortgage': 'Mortgage Real Estate Investment Trusts (REITs)', 'Real Estate Services': 'Real Estate Management & Development',
  'Real Estate - Development': 'Real Estate Management & Development', 'Real Estate - Diversified': 'Real Estate Management & Development',
};
// Known cases where Yahoo's category points to a different GICS industry than S&P uses.
const OVERRIDE = {
  UBER: 'Ground Transportation', LYFT: 'Ground Transportation', DASH: 'Hotels, Restaurants & Leisure', ABNB: 'Hotels, Restaurants & Leisure',
  BKNG: 'Hotels, Restaurants & Leisure', EXPE: 'Hotels, Restaurants & Leisure', GOOGL: 'Interactive Media & Services', GOOG: 'Interactive Media & Services',
  META: 'Interactive Media & Services', AMZN: 'Broadline Retail', V: 'Financial Services', MA: 'Financial Services', PYPL: 'Financial Services',
  NFLX: 'Entertainment', TSLA: 'Automobiles', 'BRK.B': 'Financial Services', 'BRK-B': 'Financial Services', COST: 'Consumer Staples Distribution & Retail',
  WMT: 'Consumer Staples Distribution & Retail', HD: 'Specialty Retail', LOW: 'Specialty Retail', NKE: 'Textiles, Apparel & Luxury Goods',
};
// Returns { sector, industry, source } — source is 'fund' (workbook GICS), 'spx' (S&P constituent list), 'mapped' (from Yahoo) or null.
// spxSector: the official GICS sector from the fund's S&P 500 constituent list, when the stock is in the index.
export function gicsFor(held, prof, fallbackSector, spxSector, ticker) {
  if (held && held.assetClass === 'Equity' && held.industry) {
    const industry = fullIndustry(held.industry);
    return { sector: held.sector || sectorOfIndustry(industry), industry, source: 'fund' };
  }
  const t = String(ticker || held?.ticker || prof?.symbol || '').toUpperCase();
  const yi = prof?.industry;
  let industry = OVERRIDE[t] || (yi && Y[yi]) || '';
  let sector = industry ? SECTOR_OF[industry] : null;
  if (spxSector) {
    // the S&P list is the authority on the sector; drop a mapped industry that disagrees with it
    if (sector && sector !== spxSector) industry = '';
    return { sector: spxSector, industry, source: 'spx', yahoo: yi || '' };
  }
  if (industry) return { sector, industry, source: OVERRIDE[t] ? 'spx' : 'mapped', yahoo: yi };
  return { sector: fallbackSector || null, industry: '', source: yi ? 'unmapped' : null, yahoo: yi || '' };
}
