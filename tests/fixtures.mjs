export const center = { latitude: 28.524, longitude: 77.206 };
export const placeGroups = Object.fromEntries([['food', 4], ['landmark', 3], ['nature', 3]].map(([category, count]) => [category, Array.from({ length: count }, (_, index) => ({ title: `Test ${category} ${index + 1}`, address: 'Test neighbourhood, Test city', type: category, data_id: `${category}-${index}`, data_cid: `${1000 + index + (category === 'food' ? 0 : category === 'landmark' ? 10 : 20)}`, gps_coordinates: { latitude: center.latitude + index * .001, longitude: center.longitude + .001 } }))]));
export function modelOutput(places) {
  return { cards: [...places.map((place, index) => ({ category: place.category, place_id: place.id, title: `Test side quest ${index + 1}`, mission: 'Visit the supplied place and observe an interesting detail.', evidence: 'A photo of the place exterior.', minutes: 15 })), ...[1, 2].map(index => ({ category: 'discovery', place_id: null, title: `Look closer ${index}`, mission: 'Walk outdoors and notice different shapes around you.', evidence: 'A photo of an interesting shape you find.', minutes: 10 }))] };
}
export function records() { return Object.entries(placeGroups).flatMap(([category, places]) => places.map(place => ({ id: '', name: place.title, category }))).map((place, index) => ({ ...place, id: `p${index + 1}` })); }
export function modelDraft(places) {
  const cards = modelOutput(places).cards;
  return { cards: Object.fromEntries(cards.map((card, index) => [card.place_id || `discovery_${index - places.length + 1}`, { title: card.title }])) };
}
