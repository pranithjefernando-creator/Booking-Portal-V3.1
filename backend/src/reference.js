export const reference = {
  mode: [{ code: "Ocean FCL", label: "Ocean FCL" }, { code: "Ocean LCL", label: "Ocean LCL" }, { code: "Air", label: "Air" }, { code: "Road FTL", label: "Road FTL" }, { code: "Road LTL", label: "Road LTL" }, { code: "Sea/Air", label: "Sea/Air" }],
  incoterm: [{ code: "EXW", label: "EXW - Ex Works" }, { code: "FCA", label: "FCA - Free Carrier" }, { code: "FOB", label: "FOB - Free On Board" }, { code: "CFR", label: "CFR - Cost and Freight" }, { code: "CIF", label: "CIF - Cost, Insurance and Freight" }, { code: "DAP", label: "DAP - Delivered at Place" }, { code: "DDP", label: "DDP - Delivered Duty Paid" }],
  freightTerms: [{ code: "Prepaid", label: "Prepaid" }, { code: "Collect", label: "Collect" }, { code: "STD", label: "STD - Standard" }],
  serviceLevel: [{ code: "STD", label: "STD - Standard" }, { code: "EXP", label: "EXP - Express" }, { code: "ECO", label: "ECO - Economy" }, { code: "PRI", label: "PRI - Priority" }],
  packageType: [{ code: "CTN", label: "CTN - Carton" }, { code: "PLT", label: "PLT - Pallet" }, { code: "BOX", label: "BOX - Box" }, { code: "CAS", label: "CAS - Case" }, { code: "CRT", label: "CRT - Crate" }, { code: "PCS", label: "PCS - Piece" }],
  weightUnit: [{ code: "KGS", label: "KGS" }, { code: "LBS", label: "LBS" }],
  volumeUnit: [{ code: "M3", label: "M3 - Cubic Meters" }, { code: "CF", label: "CF - Cubic Feet" }],
  orderedUnit: [{ code: "EA", label: "EA - Each" }, { code: "CTN", label: "CTN - Carton" }, { code: "PCS", label: "PCS - Pieces" }, { code: "SET", label: "SET - Set" }],
  containerType: [{ code: "20GP", label: "20GP" }, { code: "40GP", label: "40GP" }, { code: "40HC", label: "40HC" }, { code: "45HC", label: "45HC" }, { code: "20RF", label: "20RF - Reefer" }, { code: "40FR", label: "40FR - Flat Rack" }],
  legType: [{ code: "MAIN", label: "MAIN" }, { code: "PRE", label: "PRE" }, { code: "ON", label: "ON" }],
  consolMode: [{ code: "FCL", label: "FCL" }, { code: "LCL", label: "LCL" }, { code: "LSE", label: "LSE" }],
  country: [{ code: "LK", label: "LK - Sri Lanka" }, { code: "AE", label: "AE - United Arab Emirates" }, { code: "GB", label: "GB - United Kingdom" }, { code: "US", label: "US - United States" }, { code: "DE", label: "DE - Germany" }, { code: "SG", label: "SG - Singapore" }, { code: "CN", label: "CN - China" }, { code: "BS", label: "BS - Bahamas" }],
  location: [{ code: "LKCMB", label: "LKCMB - Colombo" }, { code: "AEDXB", label: "AEDXB - Dubai" }, { code: "AEJEA", label: "AEJEA - Jebel Ali" }, { code: "GBLHR", label: "GBLHR - London Heathrow" }, { code: "GBFXT", label: "GBFXT - Felixstowe" }, { code: "DEHAM", label: "DEHAM - Hamburg" }, { code: "SGSIN", label: "SGSIN - Singapore" }, { code: "USMIA", label: "USMIA - Miami" }, { code: "BSNAS", label: "BSNAS - Nassau" }, { code: "CNSHA", label: "CNSHA - Shanghai" }],
  commodity: [{ code: "APP", label: "APP - Apparel" }, { code: "ELEC", label: "ELEC - Electronics" }, { code: "FMCG", label: "FMCG - Fast Moving Consumer Goods" }, { code: "MACH", label: "MACH - Machinery" }, { code: "TELE", label: "TELE - Telecom Equipment" }],
  branch: [{ code: "CMB", label: "CMB - Colombo (100)" }, { code: "DXB", label: "DXB - Dubai (151)" }, { code: "JEA", label: "JEA - Jebel Ali (152)" }, { code: "LON", label: "LON - London (311)" }],
  cwOrg: [{ code: "TESTCO", label: "TESTCO - Test Company (Pvt) Ltd" }, { code: "ACME", label: "ACME - Acme Trading LLC" }, { code: "LANKAENG", label: "LANKAENG - Lanka Engineering" }, { code: "BRITMACH", label: "BRITMACH - Britannia Machines Ltd" }, { code: "FASHIONHUB", label: "FASHIONHUB - Fashion Hub Ltd" }, { code: "LRG", label: "LRG - London Retail Group" }, { code: "GLOBEX", label: "GLOBEX - Globex GmbH" }, { code: "INTCOMMIA", label: "INTCOMMIA - Intcomex" }, { code: "BAHTELNAS", label: "BAHTELNAS - Bahamas Telecommunications Company" }]
};
export const orgDirectory = {
  TESTCO:{code:"TESTCO",name:"Test Company (Pvt) Ltd",address1:"42 Galle Road",address2:"Level 3",city:"Colombo",state:"Western",postCode:"00300",country:"LK",phone:"+94 11 250 0500",email:"ops@testco.lk"},
  ACME:{code:"ACME",name:"Acme Trading LLC",address1:"Sheikh Zayed Road",address2:"Office 1204",city:"Dubai",state:"Dubai",postCode:"12345",country:"AE",phone:"+971 4 333 4444",email:"ops@acme.ae"},
  LANKAENG:{code:"LANKAENG",name:"Lanka Engineering",address1:"18 Industrial Estate",address2:"",city:"Ratmalana",state:"Western",postCode:"10390",country:"LK",phone:"+94 11 262 7000",email:"info@lankaeng.lk"},
  BRITMACH:{code:"BRITMACH",name:"Britannia Machines Ltd",address1:"Kingsway Business Park",address2:"Unit 7",city:"Manchester",state:"England",postCode:"M17 1AB",country:"GB",phone:"+44 161 555 0100",email:"sales@britmach.co.uk"},
  FASHIONHUB:{code:"FASHIONHUB",name:"Fashion Hub Ltd",address1:"220 Textile Avenue",address2:"FTZ",city:"Colombo",state:"Western",postCode:"00100",country:"LK",phone:"+94 11 244 8899",email:"export@fashionhub.lk"},
  LRG:{code:"LRG",name:"London Retail Group",address1:"88 Oxford Street",address2:"3rd Floor",city:"London",state:"England",postCode:"W1D 1BS",country:"GB",phone:"+44 20 7946 0000",email:"buying@lrg.co.uk"},
  GLOBEX:{code:"GLOBEX",name:"Globex GmbH",address1:"Hafenstrasse 25",address2:"",city:"Hamburg",state:"Hamburg",postCode:"20457",country:"DE",phone:"+49 40 123456",email:"logistik@globex.de"},
  INTCOMMIA:{code:"INTCOMMIA",name:"Intcomex",address1:"10310 NW 121ST WAY",address2:"Warehouse B",city:"Medley",state:"FL",postCode:"33178",country:"US",phone:"+1 305 477 6230",email:"logistics@intcomex.com"},
  BAHTELNAS:{code:"BAHTELNAS",name:"Bahamas Telecommunications Company",address1:"John F. Kennedy Drive",address2:"BTC House",city:"Nassau",state:"New Providence",postCode:"N-3048",country:"BS",phone:"+1 242 302 7000",email:"procurement@btcbahamas.com"}
};
export function orgDetails(code) { const d = orgDirectory[code]; if (!d) return { code: code || "", name: orgLabel(code), address1: "", address2: "", city: "", state: "", postCode: "", country: "" }; return { ...d }; }
export const referenceTypes = Object.keys(reference);
export function isValidCode(type, code) { const list = reference[type]; if (!list) return true; if (type === "cwOrg") return orgIndex.has(code); return list.some((x) => x.code === code); }
const orgIndex = new Map(reference.cwOrg.map((o) => [o.code, o]));
const orgCodeByName = new Map(Object.values(orgDirectory).map((o) => [String(o.name).trim().toUpperCase(), o.code]));
export function isKnownOrg(code) { return orgIndex.has(code); }
export function scopedDirectory(options) { return Object.fromEntries(options.map((o) => [o.code, orgDetails(o.code)])); }
export function orgCodeForName(name) { return orgCodeByName.get(String(name || "").trim().toUpperCase()); }
export function orgLabel(code) { const o = orgIndex.get(code); return o ? o.label : code; }
// Replaces the organisation list with master data; demo orgs stay unless the master defines the same code.
export function applyOrgMaster(rows) {
  for (const { code, name } of rows) {
    orgIndex.set(code, { code, label: `${code} - ${name}` });
    orgDirectory[code] = { ...(orgDirectory[code] || { address1: "", address2: "", city: "", state: "", postCode: "", country: "" }), code, name };
    orgCodeByName.set(String(name).trim().toUpperCase(), code);
  }
  reference.cwOrg.length = 0;
  for (const org of orgIndex.values()) reference.cwOrg.push(org);
}
