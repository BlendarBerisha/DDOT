import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { findCommune } from './communesMappingVS';
import { exponentialRetry } from '../utils/retry';

export interface ParcelSearchResult {
  egrid: string;
  number: string;
  municipality: string;
  canton: string;
  surface?: number;
  center: { x: number; y: number };
}

export interface ParcelDetails {
  egrid: string;
  number: string;
  municipality: string;
  canton: string;
  surface: number;
  zone?: string;
  owner?: string;
  coordinates: { x: number; y: number };
  attributes: Record<string, any>;
}

const SEARCH_ENDPOINT = 'https://api3.geo.admin.ch/rest/services/api/SearchServer';
const IDENTIFY_ENDPOINT = 'https://api3.geo.admin.ch/rest/services/ech/MapServer/identify';
const FEATURE_ENDPOINT = 'https://api3.geo.admin.ch/rest/services/api/feature';

const geoAdminClient = axios.create({ timeout: 10000 });

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

const searchCache = new Map<string, CacheEntry<ParcelSearchResult | null>>();
const parcelDetailsCache = new Map<string, CacheEntry<ParcelDetails | null>>();
const zonesCache = new Map<string, CacheEntry<Record<string, any>>>();
const geologyCache = new Map<string, CacheEntry<Record<string, any>>>();

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCacheValue<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl = CACHE_TTL_MS): void {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

async function geoAdminRequest<T>(url: string, params: Record<string, any>, config?: AxiosRequestConfig): Promise<T> {
  const requestConfig: AxiosRequestConfig = {
    ...(config ?? {}),
    params,
  };

  return exponentialRetry(async () => {
    const response = await geoAdminClient.get<T>(url, requestConfig);
    return response.data;
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Recherche par adresse et retourne la parcelle associée
 */
async function searchByAddress(searchText: string): Promise<ParcelSearchResult | null> {
  try {
    // D'abord chercher l'adresse
    const data = await geoAdminRequest<{ results?: any[] }>(SEARCH_ENDPOINT, {
      searchText,
      type: 'locations',
      origins: 'address',
      limit: 1,
      sr: 2056,
      lang: 'fr',
    });

    if (data?.results?.length) {
      const hit = data.results[0];
      console.log(`📍 Adresse trouvée: ${hit.attrs?.label}`);
      
      // Maintenant chercher la parcelle à ces coordonnées
      const x = hit.attrs?.y; // Note: x et y sont inversés dans l'API
      const y = hit.attrs?.x;
      
      if (x && y) {
        // L'API identify ne fonctionne pas toujours, on utilise une recherche spatiale
        // Chercher les parcelles proches de ces coordonnées
        try {
          const parcelSearchData = await geoAdminRequest<{ results?: any[] }>(SEARCH_ENDPOINT, {
            searchText: `${hit.attrs?.municipality || ''} ${hit.attrs?.zip || ''}`,
            type: 'locations',
            origins: 'parcel',
            limit: 10,
            sr: 2056,
            lang: 'fr',
          });

          if (parcelSearchData?.results?.length) {
            // Trouver la parcelle la plus proche des coordonnées de l'adresse
            let closestParcel = null;
            let minDistance = Infinity;

            for (const result of parcelSearchData.results) {
              if (result.attrs?.x && result.attrs?.y) {
                const dist = Math.sqrt(
                  Math.pow(result.attrs.x - x, 2) +
                  Math.pow(result.attrs.y - y, 2)
                );
                if (dist < minDistance && dist < 200) { // Dans un rayon de 200m
                  minDistance = dist;
                  closestParcel = result;
                }
              }
            }
            
            if (closestParcel) {
              console.log(`✅ Parcelle trouvée près de l'adresse (${Math.round(minDistance)}m): ${closestParcel.attrs?.label}`);
              
              // Extraire l'EGRID du label
              let egrid = '';
              if (closestParcel.attrs?.label) {
                const egridMatch = closestParcel.attrs.label.match(/CH\s*([\d\s]+)/);
                if (egridMatch) {
                  egrid = 'CH' + egridMatch[1].replace(/\s/g, '');
                }
              }
              
              return {
                egrid: egrid,
                number: closestParcel.attrs?.num || closestParcel.attrs?.label || '',
                municipality: hit.attrs?.municipality || '',
                canton: 'VS',
                center: { x: closestParcel.attrs?.x || x, y: closestParcel.attrs?.y || y }
              };
            }
          }
        } catch (searchError) {
          console.log('⚠️ Recherche de parcelle proche échouée:', toErrorMessage(searchError));
        }
        
        // Si on ne trouve pas de parcelle, retourner au moins les coordonnées
        console.log(`⚠️ Pas de parcelle trouvée, retour des coordonnées de l'adresse`);
        return {
          egrid: '',
          number: hit.attrs?.label || '',
          municipality: hit.attrs?.municipality || '',
          canton: 'VS',
          center: { x, y }
        };
      }
    }
    
    return null;
  } catch (error) {
    console.error('Erreur recherche par adresse:', error);
    return null;
  }
}

/**
 * Recherche une parcelle par texte libre (adresse, no parcelle …).
 */
export async function searchParcel(searchText: string): Promise<ParcelSearchResult | null> {
  const normalizedQuery = searchText.trim().toLowerCase();
  const cached = getCachedValue(searchCache, normalizedQuery);
  if (cached !== undefined) {
    console.log(`♻️ Résultat de recherche utilisé depuis le cache pour "${searchText}"`);
    return cached;
  }

  let result: ParcelSearchResult | null = null;

  try {
    console.log(`🔍 Recherche parcelle: "${searchText}"`);

    // Vérifier si c'est un EGRID direct (format CHxxxxxxxxxx)
    const egridMatch = searchText.match(/^CH\d{9,12}$/i);
    if (egridMatch) {
      console.log(`🆔 EGRID direct détecté: ${searchText}`);
      let egridResult: ParcelSearchResult | null = null;

      try {
        const data = await geoAdminRequest<{ results?: any[] }>(SEARCH_ENDPOINT, {
          searchText: searchText.toUpperCase(),
          type: 'locations',
          origins: 'parcel',
          limit: 1,
          sr: 2056,
          lang: 'fr',
        });

        if (data?.results?.length) {
          const hit = data.results[0];
          console.log(`✅ Parcelle trouvée pour EGRID ${searchText}: ${hit.attrs?.label || hit.attrs?.number}`);

          egridResult = {
            egrid: searchText.toUpperCase(),
            number: hit?.attrs?.number || hit?.attrs?.label || searchText,
            municipality: hit?.attrs?.municipality || '',
            canton: hit?.attrs?.kantonskürzel || 'VS',
            center: { x: hit.attrs?.y || 2593600, y: hit.attrs?.x || 1120000 },
          };
        }
      } catch (egridError) {
        console.log(`⚠️ Recherche EGRID échouée: ${toErrorMessage(egridError)}. Utilisation des coordonnées par défaut`);
      }

      if (!egridResult) {
        egridResult = {
          egrid: searchText.toUpperCase(),
          number: searchText,
          municipality: '',
          canton: 'VS',
          center: { x: 2593600, y: 1120000 },
        };
      }

      setCacheValue(searchCache, normalizedQuery, egridResult);
      return egridResult;
    }

    // D'abord essayer de chercher par adresse si ça ressemble à une adresse
    const hasNumber = /\d/.test(searchText);
    const hasComma = searchText.includes(',');

    if (hasNumber && (hasComma || searchText.toLowerCase().includes('route') || searchText.toLowerCase().includes('rue'))) {
      console.log(`📍 Recherche par adresse détectée`);

      const addressResult = await searchByAddress(searchText);
      if (addressResult) {
        result = addressResult;
      }
    }

    // Essayer de normaliser le nom de commune s'il s'agit d'une commune
    const communeInfo = findCommune(searchText);
    let searchTerms = [searchText];

    if (communeInfo) {
      console.log(`🏛️ Commune identifiée: ${communeInfo.name} (${communeInfo.district})`);
      searchTerms = [
        communeInfo.name,
        ...(communeInfo.searchKeywords || []),
        ...(communeInfo.germanName ? [communeInfo.germanName] : []),
      ];
    }

    for (const searchTerm of searchTerms) {
      if (result) break;

      try {
        const data = await geoAdminRequest<{ results?: any[] }>(SEARCH_ENDPOINT, {
          searchText: searchTerm,
          type: 'locations',
          origins: 'parcel',
          limit: 3,
          sr: 2056,
          lang: 'fr',
        });

        if (data?.results?.length) {
          const hit = data.results[0];
          console.log(`✅ Parcelle trouvée avec "${searchTerm}": ${hit.attrs?.label || hit.attrs?.number}`);

          let egrid = hit?.attrs?.egrid;
          if (!egrid && hit?.attrs?.label) {
            const egridMatch = hit.attrs.label.match(/CH\s*([\d\s]+)/);
            if (egridMatch) {
              egrid = 'CH' + egridMatch[1].replace(/\s/g, '');
              console.log(`📋 EGRID extrait du label: ${egrid}`);
            }
          }

          result = {
            egrid: egrid || '',
            number: hit?.attrs?.number || hit?.attrs?.label,
            municipality: hit?.attrs?.municipality || communeInfo?.name || '',
            canton: hit?.attrs?.kantonskürzel || 'VS',
            center: { x: hit.attrs?.y || 0, y: hit.attrs?.x || 0 },
          };
        }
      } catch (searchError) {
        console.log(`⚠️ Échec recherche avec "${searchTerm}": ${toErrorMessage(searchError)}`);
      }
    }
  } catch (error) {
    console.error('❌ Erreur recherche parcelle:', error);
  }

  if (!result) {
    console.log('❌ Aucune parcelle trouvée après toutes les tentatives');
  }

  setCacheValue(searchCache, normalizedQuery, result, result ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS);
  return result;
}

/**
 * Récupère les détails complets d'une parcelle par ses coordonnées
 */
export async function getParcelDetails(x: number, y: number): Promise<ParcelDetails | null> {
  const cacheKey = `${x}:${y}`;
  const cached = getCachedValue(parcelDetailsCache, cacheKey);
  if (cached !== undefined) {
    console.log(`♻️ Détails de parcelle depuis le cache (${x}, ${y})`);
    return cached;
  }

  try {
    console.log(`📊 Récupération détails parcelle (${x}, ${y})`);

    const cadastralLayers = [
      'ch.kantone.cadastralwebmap-farbe',
      'ch.swisstopo.amtliches-gebaeudeadressverzeichnis',
      'ch.are.bauzonen',
    ];

    for (const layer of cadastralLayers) {
      try {
        const data = await geoAdminRequest<{ results?: any[] }>(IDENTIFY_ENDPOINT, {
          geometry: `${x},${y}`,
          geometryFormat: 'geojson',
          geometryType: 'esriGeometryPoint',
          layers: `all:${layer}`,
          tolerance: 5,
          mapExtent: `${x - 100},${y - 100},${x + 100},${y + 100}`,
          imageDisplay: '100,100,96',
          lang: 'fr',
        });

        if (data?.results?.length) {
          const feature = data.results[0];
          const attrs = feature.attributes || {};

          console.log(`✅ Détails parcelle récupérés via ${layer}: ${attrs.nummer || attrs.egrid || 'Trouvé'}`);

          const parcelDetails: ParcelDetails = {
            egrid: attrs.egrid || attrs.EGRID || '',
            number: attrs.nummer || attrs.number || attrs.NUM || '',
            municipality: attrs.gemeinde || attrs.municipality || attrs.GEMEINDE || '',
            canton: attrs.kanton || attrs.canton || 'VS',
            surface: parseFloat(attrs.flaeche || attrs.surface || attrs.FLAECHE || '0'),
            zone: attrs.zone || attrs.ZONE || undefined,
            coordinates: { x, y },
            attributes: attrs,
          };

          setCacheValue(parcelDetailsCache, cacheKey, parcelDetails);
          return parcelDetails;
        }
      } catch (layerError) {
        console.log(`⚠️ Couche ${layer} indisponible`);
      }
    }

    console.log('❌ Aucun détail de parcelle trouvé sur toutes les couches');
  } catch (error) {
    console.error('❌ Erreur récupération détails parcelle:', error);
  }

  setCacheValue(parcelDetailsCache, cacheKey, null, NEGATIVE_CACHE_TTL_MS);
  return null;
}

/**
 * Identifie les zones et contraintes sur une parcelle
 */
export async function identifyZonesAndConstraints(x: number, y: number): Promise<Record<string, any>> {
  const cacheKey = `${x}:${y}`;
  const cached = getCachedValue(zonesCache, cacheKey);
  if (cached !== undefined) {
    console.log(`♻️ Zones et contraintes depuis le cache (${x}, ${y})`);
    return cached;
  }

  try {
    console.log(`🗺️ Identification zones et contraintes (${x}, ${y})`);

    const layers = [
      'ch.are.bauzonen',
      'ch.are.nutzungsplanung',
      'ch.are.alpenkonvention',
      'ch.bav.laerm-emissionplan_eisenbahn_2015',
      'ch.bafu.laerm-strassenlaerm_tag',
      'ch.bafu.laerm-strassenlaerm_nacht',
      'ch.kantone.cadastralwebmap-farbe',
    ];

    const results: Record<string, any> = {};

    await Promise.all(
      layers.map(async (layer) => {
        try {
          const data = await geoAdminRequest<{ results?: any[] }>(IDENTIFY_ENDPOINT, {
            geometry: `${x},${y}`,
            geometryFormat: 'geojson',
            geometryType: 'esriGeometryPoint',
            layers: `all:${layer}`,
            tolerance: 10,
            mapExtent: `${x - 500},${y - 500},${x + 500},${y + 500}`,
            imageDisplay: '500,500,96',
            lang: 'fr',
            returnGeometry: false,
          });

          const features = Array.isArray(data?.results) ? data.results : [];

          const attributes = features
            .map((feature: any) => feature.attributes || feature.properties)
            .filter(Boolean);

          if (attributes.length > 0) {
            results[layer] = attributes.length === 1 ? attributes[0] : attributes;
            console.log(`✅ ${layer}: ${attributes.length} résultat(s)`);
            return;
          }

          if (layer === 'ch.are.bauzonen' || layer === 'ch.are.nutzungsplanung') {
            try {
              const altData = await geoAdminRequest<any>(
                `https://api3.geo.admin.ch/rest/services/api/MapServer/${layer}/attributes`,
                {
                  geometry: `${x},${y}`,
                  geometryType: 'esriGeometryPoint',
                  lang: 'fr',
                },
                { timeout: 5000 },
              );

              if (altData) {
                results[layer] = altData;
                console.log(`✅ ${layer}: données trouvées (méthode alternative)`);
              }
            } catch (altError) {
              console.log(`⚠️ ${layer}: ${toErrorMessage(altError)}`);
            }
          }
        } catch (layerError) {
          if (layer === 'ch.are.bauzonen' || layer === 'ch.are.nutzungsplanung') {
            console.log(`⚠️ ${layer}: ${toErrorMessage(layerError)}`);
          }
        }
      }),
    );

    if (!results['ch.are.bauzonen'] && !results['ch.are.nutzungsplanung']) {
      console.log('🔍 Tentative d\'identification générale des zones...');
      try {
        const generalData = await geoAdminRequest<{ results?: any[] }>(
          IDENTIFY_ENDPOINT,
          {
            geometry: `${x},${y}`,
            geometryType: 'esriGeometryPoint',
            layers: 'all',
            tolerance: 20,
            mapExtent: `${x - 1000},${y - 1000},${x + 1000},${y + 1000}`,
            imageDisplay: '1000,1000,96',
            lang: 'fr',
          },
          { timeout: 15000 },
        );

        if (generalData?.results) {
          generalData.results.forEach((result: any) => {
            if (result.layerBodId && result.layerBodId.includes('zone')) {
              results[result.layerBodId] = result.attributes || result.properties || {};
              console.log(`✅ Zone trouvée: ${result.layerBodId}`);
            }
          });
        }
      } catch (generalError) {
        console.log(`⚠️ Identification générale échouée: ${toErrorMessage(generalError)}`);
      }
    }

    const ttl = Object.keys(results).length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    setCacheValue(zonesCache, cacheKey, results, ttl);
    return results;
  } catch (error) {
    console.error('❌ Erreur identification zones:', error);
    setCacheValue(zonesCache, cacheKey, {}, NEGATIVE_CACHE_TTL_MS);
    return {};
  }
}

/**
 * Récupère les informations géologiques et topographiques
 */
export async function getGeologicalInfo(x: number, y: number): Promise<Record<string, any>> {
  const cacheKey = `${x}:${y}`;
  const cached = getCachedValue(geologyCache, cacheKey);
  if (cached !== undefined) {
    console.log(`♻️ Informations géologiques depuis le cache (${x}, ${y})`);
    return cached;
  }

  try {
    console.log(`🗻 Récupération infos géologiques (${x}, ${y})`);

    const geoLayers = [
      'ch.swisstopo.geologie-geocover',
      'ch.swisstopo.geologie-geodaten-assert',
      'ch.bafu.gefahren-geologische_naturgefahren',
    ];

    const results: Record<string, any> = {};

    for (const layer of geoLayers) {
      try {
        const data = await geoAdminRequest<{ results?: any[] }>(IDENTIFY_ENDPOINT, {
          geometry: `${x},${y}`,
          geometryFormat: 'geojson',
          geometryType: 'esriGeometryPoint',
          layers: `all:${layer}`,
          tolerance: 10,
          mapExtent: `${x - 200},${y - 200},${x + 200},${y + 200}`,
          imageDisplay: '100,100,96',
          lang: 'fr',
        });

        if (data?.results?.length) {
          results[layer] = data.results[0].attributes;
          console.log(`✅ Géologie ${layer}: données trouvées`);
        }
      } catch (layerError) {
        console.log(`⚠️ Géologie ${layer}: ${toErrorMessage(layerError)}`);
      }
    }

    const ttl = Object.keys(results).length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    setCacheValue(geologyCache, cacheKey, results, ttl);
    return results;
  } catch (error) {
    console.error('❌ Erreur infos géologiques:', error);
    setCacheValue(geologyCache, cacheKey, {}, NEGATIVE_CACHE_TTL_MS);
    return {};
  }
}