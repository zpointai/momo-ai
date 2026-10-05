export function explicitWeatherRefresh(text:string):boolean {
  if(/\b(?:do not|don't|never|without)\s+(?:refresh|update|check|get)\b/i.test(text))return false;
  return /^(?:(?:please|can you|could you|would you)\s+)*(?:refresh|update|check|get|look up)\b[^.!?]{0,100}\b(?:weather|forecast)\b/i.test(text.trim());
}
