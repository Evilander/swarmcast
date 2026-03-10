// Scrape local weather forecasts from WGEM and KHQA for comparison
// Falls back gracefully if stations can't be reached

const STATIONS = [
  {
    id: 'wgem',
    name: 'WGEM',
    callsign: 'WGEM-TV',
    city: 'Quincy',
    url: 'https://www.wgem.com/weather/',
    color: '#e63946'
  },
  {
    id: 'khqa',
    name: 'KHQA',
    callsign: 'KHQA-TV',
    city: 'Quincy/Hannibal',
    url: 'https://www.khqa.com/weather/',
    color: '#457b9d'
  },
  {
    id: 'nws',
    name: 'NWS',
    callsign: 'National Weather Service',
    city: 'Lincoln, IL (ILX)',
    // NWS API is free and reliable
    apiUrl: 'https://api.weather.gov/gridpoints/ILX/18,69/forecast',
    color: '#2a9d8f'
  }
];

// Fetch NWS forecast — this is the most reliable source
async function fetchNWSForecast(lat, lon) {
  try {
    // Step 1: Get the grid point
    const pointRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
      headers: { 'User-Agent': 'SwarmCast/0.1 (weather-prediction-app)' }
    });
    if (!pointRes.ok) throw new Error(`NWS points: ${pointRes.status}`);
    const pointData = await pointRes.json();

    // Step 2: Get the forecast
    const forecastUrl = pointData.properties.forecast;
    const fcRes = await fetch(forecastUrl, {
      headers: { 'User-Agent': 'SwarmCast/0.1 (weather-prediction-app)' }
    });
    if (!fcRes.ok) throw new Error(`NWS forecast: ${fcRes.status}`);
    const fcData = await fcRes.json();

    const periods = fcData.properties.periods;

    // Find tomorrow's day and night periods
    const tomorrowDay = periods.find(p => p.isDaytime && !isToday(p.startTime));
    const tomorrowNight = periods.find(p => !p.isDaytime && !isToday(p.startTime));

    if (!tomorrowDay) return null;

    return {
      source: 'nws',
      name: 'National Weather Service',
      color: '#2a9d8f',
      forecast: {
        high: tomorrowDay.temperature,
        low: tomorrowNight?.temperature || null,
        condition: tomorrowDay.shortForecast,
        detail: tomorrowDay.detailedForecast,
        wind: tomorrowDay.windSpeed,
        windDir: tomorrowDay.windDirection,
        precipProb: tomorrowDay.probabilityOfPrecipitation?.value || 0
      },
      // Include the full 7-day for comparison
      extended: periods.slice(0, 14).map(p => ({
        name: p.name,
        temp: p.temperature,
        unit: p.temperatureUnit,
        isDaytime: p.isDaytime,
        condition: p.shortForecast,
        wind: p.windSpeed,
        detail: p.detailedForecast,
        precipProb: p.probabilityOfPrecipitation?.value || 0
      }))
    };
  } catch (err) {
    console.error('NWS fetch error:', err.message);
    return null;
  }
}

function isToday(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  return d.toDateString() === today.toDateString();
}

export async function getLocalForecasts(lat, lon) {
  console.log('📡 Fetching local forecasts...');

  const results = [];

  // NWS is the reliable one
  const nws = await fetchNWSForecast(lat, lon);
  if (nws) {
    results.push(nws);
    console.log(`  ✅ NWS: High ${nws.forecast.high}°F, ${nws.forecast.condition}`);
  }

  // Add station metadata even if we can't scrape them (for display)
  for (const station of STATIONS.filter(s => s.id !== 'nws')) {
    results.push({
      source: station.id,
      name: station.name,
      color: station.color,
      city: station.city,
      url: station.url,
      forecast: null,
      note: 'Web scraping not implemented — visit station website'
    });
  }

  return results;
}
