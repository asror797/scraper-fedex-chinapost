const { buildNotFoundResponse } = require('./response');

function mapFedexStatus(keyStatus) {
  if (!keyStatus) return 'notfound';
  const s = keyStatus.toLowerCase();
  if (s.includes('delivered')) return 'delivered';
  if (s.includes('transit') || s.includes('on its way') || s.includes('in transit')) return 'transit';
  if (s.includes('label') || s.includes('created') || s.includes('shipment information sent')) return 'pretransit';
  if (s.includes('exception') || s.includes('delay') || s.includes('clearance')) return 'exception';
  if (s.includes('pickup') || s.includes('picked up')) return 'pickup';
  if (s.includes('hold') || s.includes('undelivered')) return 'undelivered';
  if (s.includes('updated')) return 'transit';
  return 'transit';
}

function convertFedexPackage(trackingNumber, pkg) {
  if (!pkg.keyStatus && (!pkg.scanEventList || pkg.scanEventList.length === 0)) {
    return buildNotFoundResponse(trackingNumber);
  }

  const hasRealEvents = (pkg.scanEventList || []).some(e => e.date && (e.description || e.eventDescription || e.scanType));
  if (!pkg.keyStatus && !hasRealEvents) {
    return buildNotFoundResponse(trackingNumber);
  }

  const shipper = pkg.shipperAddress || {};
  const recipient = pkg.recipientAddress || {};

  return {
    trackid: trackingNumber,
    status: mapFedexStatus(pkg.keyStatus),
    original_country: shipper.countryCD || shipper.countryName || null,
    original_city_state: [shipper.city, shipper.stateCD].filter(Boolean).join(', ') || null,
    destination_country: recipient.countryCD || recipient.countryName || null,
    destination_city_state: [recipient.city, recipient.stateCD].filter(Boolean).join(', ') || null,
    _data_storage: (pkg.scanEventList || []).map(e => ({
      date: e.date || null,
      information: e.description || e.eventDescription || e.scanType || '',
      actual_position_parcel: e.scanLocation || null,
    })),
  };
}

module.exports = { mapFedexStatus, convertFedexPackage };
