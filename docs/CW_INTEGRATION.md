# CW Integration — Booking → APIM → eAdaptor (ServerID = TRN)
On "Complete booking", SBMS builds a ForwardingBooking Universal XML, POSTs it to your
Azure APIM (OAuth2 client-credentials → CW eAdaptor), and captures the actual response.

## ServerID
The outbound payload uses `<ServerID>TRN</ServerID>` (training) for ALL bookings.
Change it in `backend/src/lib/cwPayload.js` (CW_STATIC.serverId) if you retarget.

## Config (backend/.env)
CW_MODE=apim | mock
CW_APIM_BASE_URL, CW_BOOKING_PATH, CW_APIM_SUBSCRIPTION_KEY (optional)
CW_TOKEN_URL, CW_CLIENT_ID, CW_CLIENT_SECRET, CW_SCOPE

## Field mapping (only these populated; all other tags fixed)
Shipper→OrganizationAddress[ConsignorPickupDeliveryAddress]; Consignee→[ConsigneeDocumentaryAddress]
(CompanyName, Address1, City, State, Country>Code, Postcode); Mode→TransportMode>Code;
Incoterms→ShipmentIncoTerm>Code; Freight→ServiceLevel>Code; Origin/Destination→PortOfOrigin/PortOfDestination>Code;
Goods→GoodsDescription; Cargo→PackingLine(PackQty,PackType>Code,Weight,WeightUnit>Code,Volume,VolumeUnit>Code).

## Run
cd backend && node server.js         # prints CW mode
node test/cw.test.js                 # 20 checks incl. ServerID=TRN
node cw-demo.js                      # prints outbound XML + CW response
