const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TMODE = { "Ocean FCL": "SEA", "Ocean LCL": "SEA", "Air": "AIR", "Road FTL": "ROA", "Road LTL": "ROA", "Sea/Air": "SEA" };
const WUNIT = { KGS: "KG", KG: "KG", LBS: "LB", LB: "LB" };
const mapMode = (m) => TMODE[m] || m || "";
const mapWeightUnit = (u) => WUNIT[String(u || "").toUpperCase()] || u || "";
const mapVolUnit = (u) => (String(u || "").toUpperCase() || "");
const mapServiceLevel = (v) => (v && /^(STD|EXP|ECO|PRI)$/i.test(v) ? v.toUpperCase() : "STD");
const dt = (v) => { const s = String(v || "").trim(); if (!s) return ""; return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s; };
function mapContainerMode(mode) { const m = String(mode || ""); if (/ocean\s*fcl/i.test(m) || /\bfcl\b/i.test(m)) return "FCL"; if (/ocean\s*lcl/i.test(m) || /\blcl\b/i.test(m)) return "LCL"; if (/road\s*ftl/i.test(m) || /\bftl\b/i.test(m)) return "FTL"; if (/road\s*ltl/i.test(m) || /\bltl\b/i.test(m)) return "LTL"; return ""; }
function shipmentBody(b) {
  b = b || {}; const sh = b.shipper || {}; const co = b.consignee || {}; const dg = b.dg || {}; const pk = b.pickup || {}; const dates = b.dates || {};
  const cargo = (b.cargoLines && b.cargoLines.length ? b.cargoLines : [{}]); const containerMode = mapContainerMode(b.mode);
  const poRefs = []; cargo.forEach((l) => String(l.poNumbers || "").split(/[,;\s]+/).forEach((p) => { const t = p.trim(); if (t) poRefs.push(t); }));
  const orderNumbers = poRefs.length ? poRefs.map((p, i) => `        <OrderNumber>\n          <OrderReference>${esc(p)}</OrderReference>\n          <Sequence>${i + 1}</Sequence>\n        </OrderNumber>`).join("\n") : `        <OrderNumber>\n          <OrderReference></OrderReference>\n          <Sequence>1</Sequence>\n        </OrderNumber>`;
  const containers = (b.containers || []).filter((c) => c && (c.containerTypeCode || c.count));
  const containerBlock = containers.length ? `    <ContainerCollection Content="Complete">\n${containers.map((c) => `      <Container>\n        <ContainerCount>${esc(c.count)}</ContainerCount>\n        <ContainerType>\n          <Code>${esc(c.containerTypeCode)}</Code>\n        </ContainerType>\n      </Container>`).join("\n")}\n    </ContainerCollection>\n` : "";
  const packing = cargo.map((l) => { const undg = (b.isDg || l.unNumber || l.dgClass || dg.unNumber || dg.dgClass) ? `\n        <UNDGCollection>\n          <UNDG>\n            <IMOClass>${esc(l.dgClass || dg.dgClass)}</IMOClass>\n            <UNDGCode>${esc(l.unNumber || dg.unNumber)}</UNDGCode>\n          </UNDG>\n        </UNDGCollection>` : ""; return `      <PackingLine>\n        <Commodity>\n          <Code>${esc(l.commodityCode || "")}</Code>\n        </Commodity>\n        <HarmonisedCode>${esc(l.hsCode)}</HarmonisedCode>\n        <PackQty>${esc(l.packages)}</PackQty>\n        <PackType>\n          <Code>${esc(l.packageTypeCode)}</Code>\n        </PackType>\n        <Volume>${esc(l.volume)}</Volume>\n        <VolumeUnit>\n          <Code>${esc(mapVolUnit(l.volumeUnit))}</Code>\n        </VolumeUnit>\n        <Weight>${esc(l.grossWeight)}</Weight>\n        <WeightUnit>\n          <Code>${esc(mapWeightUnit(l.weightUnit))}</Code>\n        </WeightUnit>${undg}\n      </PackingLine>`; }).join("\n");
  const orgAddr = (type, o) => `      <OrganizationAddress>\n        <AddressType>${type}</AddressType>\n        <OrganizationCode>${esc(o.code)}</OrganizationCode>\n        <CompanyName>${esc(o.companyName || o.name)}</CompanyName>\n        <Address1>${esc(o.address1)}</Address1>\n        <Address2>${esc(o.address2)}</Address2>\n        <AddressOverride>false</AddressOverride>\n        <City>${esc(o.city)}</City>\n        <Country>\n          <Code>${esc(o.country)}</Code>\n        </Country>\n        <Postcode>${esc(o.postCode)}</Postcode>\n        <State>${esc(o.state)}</State>\n      </OrganizationAddress>`;
  return `    <AgentsReference>${esc(b.shipperReferenceNo)}</AgentsReference>
    <BookingConfirmationReference>${esc(b.shipperReferenceNo)}</BookingConfirmationReference>
    <ContainerMode><Code>${esc(containerMode)}</Code></ContainerMode>
    <GoodsDescription>${esc(b.goodsDescription)}</GoodsDescription>
    <PortOfDestination><Code>${esc(b.destCode)}</Code></PortOfDestination>
    <PortOfOrigin><Code>${esc(b.originCode)}</Code></PortOfOrigin>
    <RateCommodity><Code>GEN</Code></RateCommodity>
    <ServiceLevel><Code>${esc(mapServiceLevel(b.freightTerms))}</Code></ServiceLevel>
    <ShipmentIncoTerm><Code>${esc(b.incotermCode)}</Code></ShipmentIncoTerm>
    <TransportMode><Code>${esc(mapMode(b.mode))}</Code></TransportMode>
    <LocalProcessing>
      <DeliveryRequiredBy>${esc(dt(pk.deliveryRequiredBy))}</DeliveryRequiredBy>
      <EstimatedDelivery>${esc(dt(pk.estimatedDelivery))}</EstimatedDelivery>
      <EstimatedPickup>${esc(dt(pk.estimatedPickup))}</EstimatedPickup>
      <PickupRequiredBy>${esc(dt(pk.requiredDate))}</PickupRequiredBy>
      <OrderNumberCollection Content="Complete">
${orderNumbers}
      </OrderNumberCollection>
    </LocalProcessing>
${containerBlock}    <CustomizedFieldCollection>
      <CustomizedField><DataType>DateTime</DataType><Key>Cargo Ready Date</Key><Value>${esc(dt(b.cargoReadyDate))}</Value></CustomizedField>
    </CustomizedFieldCollection>
    <DateCollection>
      <Date><Type>Departure</Type><IsEstimate>true</IsEstimate><Value>${esc(dt(dates.requiredEtd))}</Value></Date>
      <Date><Type>Arrival</Type><IsEstimate>true</IsEstimate><Value>${esc(dt(dates.requiredEta))}</Value></Date>
      <Date><Type>DeliveryDueDate</Type><IsEstimate>false</IsEstimate><Value>${esc(dt(dates.requestedDelivery))}</Value></Date>
      <Date><Type>ClientRequestedETA</Type><IsEstimate>true</IsEstimate><Value>${esc(dt(b.clientRequestedEta))}</Value></Date>
    </DateCollection>
    <NoteCollection Content="Partial">
      <Note><Description>Booking Notes</Description><IsCustomDescription>false</IsCustomDescription><NoteText>${esc(b.notes)}</NoteText><NoteContext><Code>AAA</Code></NoteContext><Visibility><Code>PUB</Code></Visibility></Note>
      <Note><Description>Remarks</Description><IsCustomDescription>false</IsCustomDescription><NoteText>${esc(b.handlingRemarks)}</NoteText><NoteContext><Code>AAA</Code></NoteContext><Visibility><Code>PUB</Code></Visibility></Note>
      <Note><Description>Marks &amp; Numbers</Description><IsCustomDescription>false</IsCustomDescription><NoteText>${esc(b.marksAndNumbers)}</NoteText><NoteContext><Code>AAA</Code></NoteContext><Visibility><Code>PUB</Code></Visibility></Note>
    </NoteCollection>
    <OrganizationAddressCollection>
${orgAddr("ConsignorDocumentaryAddress", sh)}
${orgAddr("ConsigneeDocumentaryAddress", co)}
    </OrganizationAddressCollection>
    <PackingLineCollection Content="Complete">
${packing}
    </PackingLineCollection>`;
}
export function buildBookingXml(b) { b = b || {}; return `<UniversalShipment>\n  <Shipment>\n    <DataContext>\n      <DataTargetCollection>\n        <DataTarget>\n          <Type>ForwardingBooking</Type>\n          <Key></Key>\n        </DataTarget>\n      </DataTargetCollection>\n      <EnterpriseID>EXK</EnterpriseID>\n      <ServerID>TRN</ServerID>\n      <Company>\n        <Code>USA</Code>\n      </Company>\n    </DataContext>\n${shipmentBody(b)}\n  </Shipment>\n</UniversalShipment>`; }
export function buildBookingUpdateXml(b, key) { b = b || {}; const K = key ? String(key).trim() : ""; return `<UniversalShipment>\n  <Shipment>\n    <DataContext>\n      <DataTargetCollection>\n        <DataTarget>\n          <Type>ForwardingBooking</Type>\n          <Key>${esc(K)}</Key>\n        </DataTarget>\n      </DataTargetCollection>\n      <CodesMappedToTarget>1</CodesMappedToTarget>\n      <EnterpriseID>EXK</EnterpriseID>\n      <ServerID>TRN</ServerID>\n      <Company>\n        <Code>USA</Code>\n      </Company>\n    </DataContext>\n${shipmentBody(b)}\n  </Shipment>\n</UniversalShipment>`; }
