import { useState } from 'react';
import { Plane } from 'lucide-react';
import { allowedCarrierImage, type CarrierBrand } from '../../shared/carrierBranding';

export function CarrierBadge({ brand, code }: { brand?: CarrierBrand; code?: string | null }) {
  const url = brand?.availability === 'ready' && brand.imageUrl && allowedCarrierImage(brand.imageUrl) ? brand.imageUrl : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="situation-carrier-badge" aria-label={brand?.carrier.name ? `Carrier: ${brand.carrier.name}` : code ? `Carrier code ${code}` : 'Carrier'}>
    {url && failedUrl !== url ? <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailedUrl(url)}/> : code ? <b>{code}</b> : <Plane size={22} aria-hidden="true"/>}
  </span>;
}
