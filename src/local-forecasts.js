import { fetchWithTimeout } from './fetch-utils.js';

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
    color: '#2a9d8f'
  }
];

const NWS_HEADERS = Object.freeze({
  'User-Agent': `SwarmCast/${process.env.npm_package_version || '0.3.0'} (weather-prediction-app)`
});

async function fetchNWSForecast(lat, lon, options = {}) {
  try {
    const pointRes = await fetchWithTimeout(`https://api.weather.gov/points/${lat},${lon}`, {
      ...options,
      headers: {
        ...NWS_HEADERS,
        ...(options.headers || {})
      }
    });
    if (!pointRes.ok) {
      throw new Error(`NWS points: ${pointRes.status}`);
    }

    const pointData = await pointRes.json();
    const forecastUrl = pointData.properties?.forecast;
    if (!forecastUrl) {
      return null;
    }

    const forecastRes = await fetchWithTimeout(forecastUrl, {
      ...options,
      headers: {
        ...NWS_HEADERS,
        ...(options.headers || {})
      }
    });
    if (!forecastRes.ok) {
      throw new Error(`NWS forecast: ${forecastRes.status}`);
    }

    const forecastData = await forecastRes.json();
    const periods = forecastData.properties?.periods || [];
    const tomorrowDay = periods.find((period) => period.isDaytime && !isToday(period.startTime));
    const tomorrowNight = periods.find((period) => !period.isDaytime && !isToday(period.startTime));
    if (!tomorrowDay) {
      return null;
    }

    return {
      source: 'nws',
      name: 'National Weather Service',
      color: '#2a9d8f',
      forecast: {
        high: tomorrowDay.temperature,
        low: tomorrowNight?.temperature ?? null,
        condition: tomorrowDay.shortForecast,
        detail: tomorrowDay.detailedForecast,
        wind: tomorrowDay.windSpeed,
        windDir: tomorrowDay.windDirection,
        precipProb: tomorrowDay.probabilityOfPrecipitation?.value || 0
      },
      extended: periods.slice(0, 14).map((period) => ({
        name: period.name,
        temp: period.temperature,
        unit: period.temperatureUnit,
        isDaytime: period.isDaytime,
        condition: period.shortForecast,
        wind: period.windSpeed,
        detail: period.detailedForecast,
        precipProb: period.probabilityOfPrecipitation?.value || 0
      }))
    };
  } catch {
    return null;
  }
}

function isToday(dateStr) {
  const candidate = new Date(dateStr);
  const today = new Date();
  return candidate.toDateString() === today.toDateString();
}

export async function getLocalForecasts(lat, lon, options = {}) {
  const results = [];
  const nws = await fetchNWSForecast(lat, lon, options);
  if (nws) {
    results.push(nws);
  }

  for (const station of STATIONS.filter((station) => station.id !== 'nws')) {
    results.push({
      source: station.id,
      name: station.name,
      color: station.color,
      city: station.city,
      url: station.url,
      forecast: null,
      note: 'Web scraping not implemented; visit the station website.'
    });
  }

  return results;
}
