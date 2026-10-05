export function derivativesFeatures({fundingRate=0,openInterestChange=0,basis=0,liquidations=0}={}){
  return Object.freeze({fundingRate:Number(fundingRate)||0,openInterestChange:Number(openInterestChange)||0,basis:Number(basis)||0,liquidations:Number(liquidations)||0});
}
export function derivativesSignal(f){if(!f)return "WAIT";if(f.fundingRate>.01&&f.openInterestChange>0)return "CROWDED_LONG";if(f.fundingRate<-.01&&f.openInterestChange>0)return "CROWDED_SHORT";return "NEUTRAL";}
