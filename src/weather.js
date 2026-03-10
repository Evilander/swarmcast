import { fetchWithTimeout } from './fetch-utils.js';

const BASE = 'https://api.open-meteo.com/v1';
const NWS_HEADERS = Object.freeze({
  'User-Agent': `SwarmCast/${process.env.npm_package_version || '0.3.0'} (weather-forecast-app)`
});

// Fetch severe weather / convective parameters
export async function getSevereParams(lat, lon, options = {}) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: [
      'cape', 'convective_inhibition',
      'wind_gusts_10m', 'wind_speed_10m',
      'precipitation_probability', 'weather_code'
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'America/Chicago',
    forecast_days: 3
  });

  const res = await fetchWithTimeout(`${BASE}/forecast?${params}`, options);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.hourly) return null;

  const days = {};
  for (let i = 0; i < data.hourly.time.length; i++) {
    const date = data.hourly.time[i].split('T')[0];
    if (!days[date]) days[date] = { cape: [], cin: [], gusts: [], wind: [], precipProb: [], codes: [], times: [] };
    days[date].cape.push(data.hourly.cape[i] || 0);
    days[date].cin.push(data.hourly.convective_inhibition[i] || 0);
    days[date].gusts.push(data.hourly.wind_gusts_10m[i] || 0);
    days[date].wind.push(data.hourly.wind_speed_10m[i] || 0);
    days[date].precipProb.push(data.hourly.precipitation_probability[i] || 0);
    days[date].codes.push(data.hourly.weather_code[i] || 0);
    days[date].times.push(data.hourly.time[i]);
  }

  return Object.entries(days).map(([date, d]) => {
    const maxCapeIdx = d.cape.indexOf(Math.max(...d.cape));
    return {
      date,
      maxCape: Math.round(Math.max(...d.cape)),
      avgCape: Math.round(d.cape.reduce((a, b) => a + b, 0) / d.cape.length),
      peakCapeTime: d.times[maxCapeIdx],
      maxGusts: Math.round(Math.max(...d.gusts) * 10) / 10,
      maxWind: Math.round(Math.max(...d.wind) * 10) / 10,
      maxPrecipProb: Math.max(...d.precipProb),
      capeProfile: d.cape,
      gustProfile: d.gusts,
      thunderstormHours: d.codes.filter(c => c >= 95).length,
      stormHours: d.codes.filter(c => c >= 80).length,
      severity: assessSeverity(Math.max(...d.cape), Math.max(...d.gusts), Math.max(...d.precipProb), d.codes)
    };
  });
}

function assessSeverity(maxCape, maxGusts, maxPrecipProb, codes) {
  let score = 0;
  if (maxCape >= 1000) score += 1;
  if (maxCape >= 2000) score += 1;
  if (maxCape >= 3000) score += 2;
  if (maxGusts >= 40) score += 1;
  if (maxGusts >= 58) score += 2; // NWS severe criteria
  if (maxGusts >= 75) score += 2;
  if (maxPrecipProb >= 60) score += 1;
  if (codes.some(c => c >= 95)) score += 2;
  if (codes.some(c => c >= 99)) score += 2;

  if (score >= 6) return { level: 'extreme', label: 'EXTREME', color: '#ff00ff' };
  if (score >= 4) return { level: 'high', label: 'HIGH RISK', color: '#ff0000' };
  if (score >= 2) return { level: 'moderate', label: 'MODERATE', color: '#ff8800' };
  if (score >= 1) return { level: 'slight', label: 'SLIGHT', color: '#ffcc00' };
  return { level: 'none', label: 'LOW', color: '#44aa44' };
}

// Fetch active NWS alerts for a location
export async function getNWSAlerts(lat, lon, options = {}) {
  try {
    const res = await fetchWithTimeout(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
      ...options,
      headers: {
        ...NWS_HEADERS,
        ...(options.headers || {})
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features || []).map(f => ({
      event: f.properties.event,
      severity: f.properties.severity,
      urgency: f.properties.urgency,
      certainty: f.properties.certainty,
      headline: f.properties.headline,
      description: f.properties.description,
      instruction: f.properties.instruction,
      onset: f.properties.onset,
      expires: f.properties.expires,
      senderName: f.properties.senderName
    }));
  } catch {
    return [];
  }
}

export async function getCurrentAndForecast(lat, lon, options = {}) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'precipitation', 'weather_code', 'cloud_cover',
      'wind_speed_10m', 'wind_direction_10m', 'pressure_msl',
      'surface_pressure'
    ].join(','),
    hourly: [
      'temperature_2m', 'relative_humidity_2m', 'precipitation_probability',
      'precipitation', 'weather_code', 'cloud_cover',
      'wind_speed_10m', 'wind_gusts_10m', 'pressure_msl',
      'visibility', 'uv_index'
    ].join(','),
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'apparent_temperature_max', 'apparent_temperature_min',
      'sunrise', 'sunset', 'precipitation_sum',
      'precipitation_probability_max', 'wind_speed_10m_max',
      'wind_gusts_10m_max', 'uv_index_max'
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'America/Chicago',
    forecast_days: 7,
    past_days: 3
  });

  const res = await fetchWithTimeout(`${BASE}/forecast?${params}`, options);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json();
}

export async function getHistorical(lat, lon, startDate, endDate, options = {}) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    start_date: startDate,
    end_date: endDate,
    daily: [
      'temperature_2m_max', 'temperature_2m_min',
      'precipitation_sum', 'wind_speed_10m_max'
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'America/Chicago'
  });

  const res = await fetchWithTimeout(`${BASE}/archive?${params}`, options);
  if (!res.ok) throw new Error(`Open-Meteo archive error: ${res.status}`);
  return res.json();
}

// Weather code descriptions
const WMO_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
};

export function describeWeatherCode(code) {
  return WMO_CODES[code] || `Unknown (${code})`;
}

export function summarizeWeatherData(data) {
  const c = data.current;
  const d = data.daily;

  const today = {
    temp: c.temperature_2m,
    feelsLike: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    precipitation: c.precipitation,
    condition: describeWeatherCode(c.weather_code),
    cloudCover: c.cloud_cover,
    windSpeed: c.wind_speed_10m,
    windDir: c.wind_direction_10m,
    pressure: c.pressure_msl,
    surfacePressure: c.surface_pressure
  };

  const forecast = [];
  for (let i = 0; i < d.time.length; i++) {
    forecast.push({
      date: d.time[i],
      high: d.temperature_2m_max[i],
      low: d.temperature_2m_min[i],
      condition: describeWeatherCode(d.weather_code[i]),
      precipSum: d.precipitation_sum[i],
      precipProb: d.precipitation_probability_max[i],
      windMax: d.wind_speed_10m_max[i],
      gustMax: d.wind_gusts_10m_max[i],
      uvMax: d.uv_index_max[i],
      sunrise: d.sunrise[i],
      sunset: d.sunset[i]
    });
  }

  // Extract past 3 days vs future 7 days
  const pastDays = forecast.filter(f => new Date(f.date) < new Date(new Date().toDateString()));
  const futureDays = forecast.filter(f => new Date(f.date) >= new Date(new Date().toDateString()));

  // Hourly data for next 24h
  const now = new Date();
  const next24h = [];
  for (let i = 0; i < data.hourly.time.length && next24h.length < 24; i++) {
    const t = new Date(data.hourly.time[i]);
    if (t >= now) {
      next24h.push({
        time: data.hourly.time[i],
        temp: data.hourly.temperature_2m[i],
        humidity: data.hourly.relative_humidity_2m[i],
        precipProb: data.hourly.precipitation_probability[i],
        precip: data.hourly.precipitation[i],
        condition: describeWeatherCode(data.hourly.weather_code[i]),
        cloudCover: data.hourly.cloud_cover[i],
        windSpeed: data.hourly.wind_speed_10m[i],
        gusts: data.hourly.wind_gusts_10m[i],
        pressure: data.hourly.pressure_msl[i],
        visibility: data.hourly.visibility[i],
        uvIndex: data.hourly.uv_index[i]
      });
    }
  }

  return { current: today, pastDays, futureDays, next24h };
}
