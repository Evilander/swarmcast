// Available forecast locations

export const LOCATIONS = [
  {
    id: 'mt-sterling',
    name: 'Mt. Sterling, IL',
    lat: '39.9870',
    lon: '-90.7601',
    timezone: 'America/Chicago',
    description: 'Central Illinois'
  },
  {
    id: 'quincy',
    name: 'Quincy, IL',
    lat: '39.9356',
    lon: '-91.4099',
    timezone: 'America/Chicago',
    description: 'Mississippi river town'
  },
  {
    id: 'chicago',
    name: 'Chicago, IL',
    lat: '41.8781',
    lon: '-87.6298',
    timezone: 'America/Chicago',
    description: 'The city'
  },
  {
    id: 'springfield',
    name: 'Springfield, IL',
    lat: '39.7817',
    lon: '-89.6501',
    timezone: 'America/Chicago',
    description: 'State capital'
  }
];

export function getLocation(id) {
  return LOCATIONS.find(l => l.id === id) || LOCATIONS[0];
}

export function getDefaultLocation() {
  return LOCATIONS[0];
}
