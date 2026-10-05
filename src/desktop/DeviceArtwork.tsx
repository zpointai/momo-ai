import { useState } from 'react';
import { Box, Lightbulb, Plug, Radio, Router, Wind } from 'lucide-react';

export type ArtworkSource = 'OFFICIAL_AUTHORIZED' | 'MOMO_ORIGINAL' | 'CATEGORY_FALLBACK';
export type VisualCategory = 'light' | 'bridge' | 'sensor' | 'plug' | 'appliance' | 'unknown';
export type ArtworkQuery = {vendor?:string;model?:string;category:VisualCategory};
type LocalArtwork = {vendor:string;model:string;category:VisualCategory;asset:string;label:string};
export type AuthorizedArtwork = LocalArtwork & {source:'OFFICIAL_AUTHORIZED';provenance:{source:string;permission:string;obtainedAt:string}};
export type OriginalArtwork = LocalArtwork & {source:'MOMO_ORIGINAL';provenance:{creator:'MoMo';description:string}};
export type Artwork = AuthorizedArtwork | OriginalArtwork | {source:'CATEGORY_FALLBACK';category:VisualCategory;label:string};
// Deliberately empty until the owner receives explicit integration-use permission.
export const authorizedDeviceArtwork:readonly AuthorizedArtwork[]=[];
export const originalDeviceArtwork:readonly OriginalArtwork[]=[
  {vendor:'Govee',model:'H70C4',category:'light',source:'MOMO_ORIGINAL',asset:'./assets/home-string-lights.svg',label:'Decorative string lights illustration',provenance:{creator:'MoMo',description:'Original planar string-light geometry; no vendor artwork used. Illustration is not device state.'}},
  {vendor:'Govee',model:'H61C3',category:'light',source:'MOMO_ORIGINAL',asset:'./assets/home-linear-light.svg',label:'Generic lighting illustration',provenance:{creator:'MoMo',description:'Neutral linear-light motif for a documented light category; not an assertion of exact product shape.'}},
];
const labels:Record<VisualCategory,string>={light:'Light',bridge:'Bridge',sensor:'Sensor',plug:'Smart plug',appliance:'Appliance',unknown:'Device'};
const icons={light:Lightbulb,bridge:Router,sensor:Radio,plug:Plug,appliance:Wind,unknown:Box};
const fallback=(category:VisualCategory):Artwork=>({source:'CATEGORY_FALLBACK',category,label:`${labels[category]} category icon`});
// Artwork only consumes display metadata; it never resolves LAN identity or grants authority.
// Restrained production slots retain authorized-art priority while leaving original illustrations dormant.
export function resolveDeviceArtwork(query:ArtworkQuery,official:readonly AuthorizedArtwork[]=authorizedDeviceArtwork,presentation:'full'|'restrained'='full'):Artwork {
  const matches=(art:LocalArtwork)=>art.vendor===query.vendor&&art.model===query.model&&art.category===query.category;
  return official.find(art=>matches(art)&&art.asset.startsWith('./assets/home-')&&art.provenance.permission.trim()&&art.provenance.source.trim()&&art.provenance.obtainedAt.trim())??(presentation==='full'?originalDeviceArtwork.find(matches):undefined)??fallback(query.category);
}
export function DeviceArtwork({vendor,model,category,size='thumbnail',decorative=false,presentation='full'}:{vendor?:string;model?:string;category:VisualCategory;size?:'icon'|'thumbnail'|'hero';decorative?:boolean;presentation?:'full'|'restrained'}) {
  const art=resolveDeviceArtwork({vendor,model,category},authorizedDeviceArtwork,presentation);
  const [failedAsset,setFailedAsset]=useState<string|null>(null);
  const resolved='asset' in art&&failedAsset===art.asset?fallback(category):art;
  const Icon=icons[category];
  return <span className={`home-device-art home-device-art--${size}`} data-artwork-source={resolved.source} role={decorative?undefined:'img'} aria-label={decorative?undefined:resolved.label} aria-hidden={decorative||undefined}>
    {'asset' in resolved?<img src={resolved.asset} alt="" draggable={false} onError={()=>setFailedAsset(resolved.asset)}/>:<Icon size={size==='hero'?54:size==='icon'?22:28} strokeWidth={1.5}/>}
  </span>;
}
