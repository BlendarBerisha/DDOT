import { searchParcel, getParcelDetails, identifyZonesAndConstraints, getGeologicalInfo, type ParcelSearchResult, type ParcelDetails } from './geoAdmin';
import { getPLRRestrictions, getBuildingZoneInfo, formatPLRForAnalysis, type PLRData } from './plrCadastre';
import { findCommunalRegulations, analyzeCommunalRegulation, formatRegulationsForAnalysis, type CommunalRegulation } from './communalRegulations';
import { geocodeAddress, getFallbackCoordinates, type GeocodeResult } from './geocodingVS';
import { getAllAdditionalData, formatAdditionalDataForAI, type CantonalDataResult } from './additionalDataSources';
import { buildConstraintTable } from './buildConstraintTable';
import { analyzeRdppf, type RdppfConstraint, extractTextFromPdf, downloadRdppf } from './rdppfExtractor';
// import { extractRdppfData, findZoneConstraints, generateNoiseConstraints, type RdppfData } from './rdppfEnhancedExtractor';
import { RegulationConstraint } from './regulationExtractor';
import { calculerDensiteValais, formaterResultatsValais, extraireIndicesReglement, type ValaisDensityCalculation } from './valaisDensityCalculator';

export interface ComprehensiveParcelAnalysis {
  // Données de base
  searchQuery: string;
  searchResult: ParcelSearchResult | null;
  parcelDetails: ParcelDetails | null;
  geocodeResult: GeocodeResult | null;
  
  // Données cadastrales
  zones: Record<string, any>;
  geologicalInfo: Record<string, any>;
  buildingZone: Record<string, any>;
  
  // Restrictions légales
  plrData: PLRData | null;
  communalRegulations: CommunalRegulation[];
  
  // Données supplémentaires
  additionalData: CantonalDataResult[];
  
  // Nouvelles données structurées à partir des règlements communaux
  communalConstraints: import('./regulationExtractor').RegulationConstraint[];
  rdppfConstraints: RdppfConstraint[];
  rdppfData?: any; // RdppfData - Données RDPPF structurées améliorées
  
  // Calculs de densité spécifiques au Valais
  valaisDensity?: ValaisDensityCalculation;
  
  // Métadonnées
  processingTime: number;
  completeness: number; // Pourcentage de données récupérées avec succès
  errors: string[];
  
  // Données formatées pour OpenAI
  formattedForAI: string;
}

/**
 * Orchestre une analyse complète de parcelle avec toutes les sources
 */
export async function performComprehensiveAnalysis(searchQuery: string): Promise<ComprehensiveParcelAnalysis> {
  const startTime = Date.now();
  console.log(`🚀 Début analyse complète pour: "${searchQuery}"`);
  
  const analysis: ComprehensiveParcelAnalysis = {
    searchQuery,
    searchResult: null,
    parcelDetails: null,
    geocodeResult: null,
    zones: {},
    geologicalInfo: {},
    buildingZone: {},
    plrData: null,
    communalRegulations: [],
    additionalData: [],
    communalConstraints: [],
    rdppfConstraints: [],
    valaisDensity: undefined,
    processingTime: 0,
    completeness: 0,
    errors: [],
    formattedForAI: ''
  };
  
  let successCount = 0;
  const totalSteps = 5; // Nombre total d'étapes simplifiées (sans dangers naturels)
  console.log('🎯 Démarrage analyse complète avec 5 étapes:');
  console.log('  1. Recherche parcelle');
  console.log('  2. Extraction RDPPF');
  console.log('  3. Zones et contraintes GeoAdmin');
  console.log('  4. Règlement communal');
  console.log('  5. Calcul densité constructible (indices U/IBUS)');
  
  try {
    // ÉTAPE 1: Recherche de la parcelle
    console.log('📍 Étape 1/5: Recherche parcelle...');
    try {
      analysis.searchResult = await searchParcel(searchQuery);
      if (analysis.searchResult) {
        successCount++;
        console.log(`✅ Parcelle trouvée: ${analysis.searchResult.egrid}`);
      } else {
        analysis.errors.push('Parcelle non trouvée');
        console.log('❌ Parcelle non trouvée');
        // Si on ne trouve pas la parcelle, on ne peut pas continuer
        analysis.processingTime = Date.now() - startTime;
        analysis.completeness = 0;
        analysis.formattedForAI = generateErrorMessage(searchQuery, analysis.errors);
        return analysis;
      }
    } catch (error) {
      analysis.errors.push(`Erreur recherche parcelle: ${toErrorMessage(error)}`);
    }
    
    if (!analysis.searchResult) {
      analysis.processingTime = Date.now() - startTime;
      analysis.completeness = 0;
      analysis.formattedForAI = generateErrorMessage(searchQuery, analysis.errors);
      return analysis;
    }

    // Géocodage complémentaire pour fiabiliser les coordonnées
    console.log('🧭 Géocodage complémentaire...');
    try {
      const geocoded = await geocodeAddress(searchQuery);
      if (geocoded) {
        analysis.geocodeResult = geocoded;
        console.log(`✅ Géocodage précis via ${geocoded.source}`);
      } else if (analysis.searchResult?.municipality) {
        const fallback = getFallbackCoordinates(analysis.searchResult.municipality);
        if (fallback) {
          analysis.geocodeResult = fallback;
          console.log(`⚠️ Géocodage approximatif utilisé (${fallback.source})`);
        }
      }

      if (!analysis.geocodeResult && analysis.searchResult) {
        analysis.geocodeResult = {
          coordinates: analysis.searchResult.center,
          address: analysis.searchResult.number || searchQuery,
          municipality: analysis.searchResult.municipality || '',
          canton: analysis.searchResult.canton,
          accuracy: 'approximate',
          source: 'GeoAdmin Search',
        };
        console.log('⚠️ Utilisation des coordonnées retournées par la recherche GeoAdmin');
      }
    } catch (error) {
      analysis.errors.push(`Erreur géocodage: ${toErrorMessage(error)}`);
    }

    const { x, y } = analysis.searchResult.center;
    const egrid = analysis.searchResult.egrid;

    // ÉTAPE 2: RDPPF
    console.log('📑 Étape 2/5: RDPPF...');
    try {
      // Construire l'URL RDPPF à partir de l'EGRID
      let rdppfUrl = null;
      if (analysis.searchResult?.egrid) {
        rdppfUrl = `https://rdppfvs.geopol.ch/extract/pdf?EGRID=${analysis.searchResult.egrid}&LANG=fr`;
        console.log(`📑 URL RDPPF construite: ${rdppfUrl}`);
      }
      
      if (rdppfUrl) {
        try {
          console.log(`📑 Tentative téléchargement RDPPF...`);
          
          // Télécharger et extraire le texte du RDPPF
          const pdfPath = await downloadRdppf(rdppfUrl);
          const rdppfText = await extractTextFromPdf(pdfPath);
          
          // Utiliser directement analyzeRdppf avec les améliorations
          analysis.rdppfConstraints = await analyzeRdppf(rdppfUrl);
          if (analysis.rdppfConstraints.length) {
            successCount++;
            console.log(`✅ Étape 2 réussie: ${analysis.rdppfConstraints.length} contraintes RDPPF`);
          } else {
            console.log('❌ Étape 2 échouée: Aucune contrainte RDPPF extraite');
          }
          
          // Extraire les informations structurées des contraintes
          const zoneConstraint = analysis.rdppfConstraints.find(c => c.theme === 'Destination de zone');
          const noiseConstraint = analysis.rdppfConstraints.find(c => 
            c.theme === 'Prescriptions architecturales' && c.rule.includes('Degré de sensibilité')
          );
          
          if (zoneConstraint) {
            // Parser la zone depuis la rule
            // La rule peut être: "Zone résidentielle 0.5 (3), Surface: 862 m², 100.0%"
            const zoneMatch = zoneConstraint.rule.match(/^([^,]+)/);
            if (zoneMatch) {
              const zoneDesignation = zoneMatch[1].trim();
              analysis.rdppfData = {
                zoneAffectation: {
                  designation: zoneDesignation
                }
              };
              console.log(`✅ Zone extraite du RDPPF: ${zoneDesignation}`);
              
              // Extraire aussi la surface si présente
              const surfaceMatch = zoneConstraint.rule.match(/Surface:\s*(\d+)\s*m²/);
              if (surfaceMatch) {
                analysis.rdppfData.zoneAffectation.surface = parseInt(surfaceMatch[1]);
                console.log(`📏 Surface extraite: ${analysis.rdppfData.zoneAffectation.surface} m²`);
              }
            }
          }
          
          // Si on a des contraintes mais pas de zone spécifique, logger pour debug
          if (analysis.rdppfConstraints.length > 0 && !analysis.rdppfData?.zoneAffectation) {
            console.log('⚠️ Contraintes RDPPF trouvées mais aucune zone d\'affectation:');
            analysis.rdppfConstraints.forEach(c => {
              if (c.theme.toLowerCase().includes('zone') || c.rule.toLowerCase().includes('zone')) {
                console.log(`  - ${c.theme}: ${c.rule.substring(0, 100)}...`);
              }
            });
          }
          
          console.log(`📑 RDPPF analysé: ${analysis.rdppfConstraints.length} contraintes extraites`);
        } catch (rdppfError: any) {
          const rdppfMessage = toErrorMessage(rdppfError);
          console.log(`❌ Étape 2 échouée - Erreur RDPPF: ${rdppfMessage}`);
          const stackPreview = typeof rdppfError?.stack === 'string' ? rdppfError.stack.substring(0, 200) : '';
          if (stackPreview) {
            console.log(`📑 Stack: ${stackPreview}...`);
          }
          analysis.errors.push(`RDPPF: ${rdppfMessage}`);
        }
      } else {
        console.log('⚠️ Pas d\'EGRID disponible pour construire l\'URL RDPPF');
      }
    } catch (error) {
      analysis.errors.push(`Erreur RDPPF: ${toErrorMessage(error)}`);
    }
    
    // ÉTAPE 3: Données territoriales complémentaires
    console.log('🗺️ Étape 3/5: Données territoriales...');
    try {
      const [
        parcelDetailsResult,
        zonesResult,
        geologicalResult,
        buildingZoneResult,
        additionalDataResult,
        plrResult,
      ] = await Promise.allSettled([
        getParcelDetails(x, y),
        identifyZonesAndConstraints(x, y),
        getGeologicalInfo(x, y),
        getBuildingZoneInfo(x, y),
        getAllAdditionalData(x, y),
        egrid ? getPLRRestrictions(egrid) : Promise.resolve<PLRData | null>(null),
      ] as const);

      let step3Success = false;

      if (parcelDetailsResult.status === 'fulfilled' && parcelDetailsResult.value) {
        analysis.parcelDetails = parcelDetailsResult.value;
        step3Success = true;
        console.log('✅ Détails de parcelle récupérés');
      } else if (parcelDetailsResult.status === 'rejected') {
        analysis.errors.push(`Détails parcelle: ${toErrorMessage(parcelDetailsResult.reason)}`);
      }

      if (zonesResult.status === 'fulfilled') {
        analysis.zones = zonesResult.value;
        if (Object.keys(analysis.zones).length > 0) {
          step3Success = true;
          console.log('✅ Zones GeoAdmin identifiées');
        } else {
          console.log('❌ Aucune zone GeoAdmin trouvée');
        }
      } else {
        analysis.errors.push(`Zones: ${toErrorMessage(zonesResult.reason)}`);
      }

      if (geologicalResult.status === 'fulfilled') {
        analysis.geologicalInfo = geologicalResult.value;
        if (Object.keys(analysis.geologicalInfo).length > 0) {
          step3Success = true;
          console.log('✅ Informations géologiques disponibles');
        }
      } else {
        analysis.errors.push(`Infos géologiques: ${toErrorMessage(geologicalResult.reason)}`);
      }

      if (buildingZoneResult.status === 'fulfilled' && buildingZoneResult.value) {
        analysis.buildingZone = buildingZoneResult.value;
        if (Object.keys(analysis.buildingZone).length > 0) {
          step3Success = true;
          console.log('✅ Zone de construction identifiée');
        }
      } else if (buildingZoneResult.status === 'rejected') {
        analysis.errors.push(`Zone de construction: ${toErrorMessage(buildingZoneResult.reason)}`);
      }

      if (additionalDataResult.status === 'fulfilled') {
        const additionalValue = additionalDataResult.value;
        analysis.additionalData = additionalValue.results;
        console.log(`📈 ${additionalValue.summary}`);
        if (analysis.additionalData.some((entry) => entry.success)) {
          step3Success = true;
        }
      } else {
        analysis.errors.push(`Données supplémentaires: ${toErrorMessage(additionalDataResult.reason)}`);
      }

      if (plrResult.status === 'fulfilled' && plrResult.value) {
        analysis.plrData = plrResult.value;
        step3Success = true;
        console.log('✅ Restrictions PLR récupérées');
      } else if (plrResult.status === 'rejected') {
        analysis.errors.push(`PLR: ${toErrorMessage(plrResult.reason)}`);
      }

      if (step3Success) {
        successCount++;
        console.log('✅ Étape 3 réussie: Données territoriales consolidées');
      } else {
        console.log('❌ Étape 3 échouée: Données territoriales indisponibles');
      }
    } catch (error) {
      analysis.errors.push(`Erreur données territoriales: ${toErrorMessage(error)}`);
    }
    
    // ÉTAPE 4: Règlements communaux
    console.log('🏛️ Étape 4/5: Règlements communaux...');
    // Extraire la commune depuis searchResult.number (format: "<b>Vétroz</b> 12558...")
    let municipality = analysis.parcelDetails?.municipality || analysis.searchResult?.municipality || '';
    if (!municipality && analysis.searchResult?.number) {
      const municipalityMatch = analysis.searchResult.number.match(/<b>([^<]+)<\/b>/);
      if (municipalityMatch) {
        municipality = municipalityMatch[1];
        // IMPORTANT: Si c'est un code postal (4 chiffres), extraire le nom de commune après
        if (/^\d{4}$/.test(municipality)) {
          const realMunicipalityMatch = analysis.searchResult.number.match(/\d{4}\s+([^<]+)/);
          if (realMunicipalityMatch) {
            municipality = realMunicipalityMatch[1].trim();
            console.log(`📋 Commune corrigée (sans code postal): ${municipality}`);
          }
        } else {
          console.log(`📋 Commune extraite du label: ${municipality}`);
        }
      }
    }
    
    if (municipality) {
      try {
        // Lire directement le PDF local du règlement communal
        const localRegulationPath = `reglements/VS_${municipality}_Règlement des constructions.pdf`;
        console.log(`📋 Lecture règlement local: ${localRegulationPath}`);
        
        try {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          
          const fullPath = path.join(process.cwd(), localRegulationPath);
          
          let regulationText = '';
          
          // Extraction directe du PDF (tous les règlements sont déjà OCR)
          await fs.access(fullPath);
          
          // Utiliser pdf-parse pour extraire le texte directement
          const pdfParse = (await import('pdf-parse')).default;
          const pdfBuffer = await fs.readFile(fullPath);
          const pdfData = await pdfParse(pdfBuffer);
          regulationText = pdfData.text;
          
          console.log(`✅ Texte extrait du PDF: ${regulationText.length} caractères`);
          console.log(`📄 Pages: ${pdfData.numpages}`)
          
          if (regulationText && regulationText.length > 500) {
            // Extraire les contraintes structurées du règlement
            const { extractConstraintsFromLargeText } = await import('./regulationExtractor');
            analysis.communalConstraints = await extractConstraintsFromLargeText(regulationText);
            
            // Si on a trouvé une zone dans le RDPPF, la loguer
            if (analysis.rdppfData?.zoneAffectation) {
              console.log(`🔍 Zone trouvée dans RDPPF: ${analysis.rdppfData.zoneAffectation.designation}`);
              
              // TODO: Implémenter la recherche de contraintes spécifiques
              // const zoneConstraints = await findZoneConstraints(
              //   analysis.rdppfData.zoneAffectation.designation,
              //   regulationText
              // );
            }
            
            console.log(`✅ Règlement analysé: ${analysis.communalConstraints.length} contraintes extraites au total`);
            if (analysis.communalConstraints.length > 0) {
              successCount++;
              console.log('✅ Étape 4 réussie: Contraintes du règlement communal extraites');
            } else {
              console.log('❌ Étape 4 échouée: Aucune contrainte communale extraite');
            }
          }
        } catch (fileError: any) {
          console.log(`⚠️ Règlement local non trouvé (${fileError.message}), recherche web...`);
          // Fallback vers la recherche web originale
          const regulations = await findCommunalRegulations(municipality);
          for (let i = 0; i < Math.min(regulations.length, 2); i++) {
            const analyzed = await analyzeCommunalRegulation(regulations[i]);
            analysis.communalRegulations.push(analyzed);
          }
          if (analysis.communalRegulations.length > 0) {
            for (const reg of analysis.communalRegulations) {
              if (reg.structuredConstraints?.length) {
                analysis.communalConstraints.push(...reg.structuredConstraints);
              }
            }
            successCount++;
          }
        }
      } catch (error) {
        analysis.errors.push(`Erreur règlements: ${toErrorMessage(error)}`);
      }
    }
    
    // ÉTAPE 5: Calcul de densité constructible (Valais)
    console.log('📏 Étape 5/5: Calcul densité constructible...');
    try {
      // Essayer de récupérer la surface depuis différentes sources
      let terrainSurface = analysis.parcelDetails?.surface || 
                          analysis.rdppfData?.zoneAffectation?.surface ||
                          0;
      
      if (terrainSurface > 0 && municipality) {
        console.log(`📏 Calcul densité pour terrain de ${terrainSurface} m² (${municipality})`);
        
        // Extraire les indices depuis les règlements communaux
        let indices: { indiceU?: number; indiceIBUS?: number } = {};
        
        // 1. Depuis les contraintes communales extraites
        for (const constraint of analysis.communalConstraints) {
          if (constraint.theme === "Indice d'utilisation (IBUS)" && constraint.rule) {
            const extracted = extraireIndicesReglement(constraint.rule);
            if (extracted.indiceU) indices.indiceU = extracted.indiceU;
            if (extracted.indiceIBUS) indices.indiceIBUS = extracted.indiceIBUS;
          }
        }
        
        // 2. Depuis les contraintes RDPPF
        for (const constraint of analysis.rdppfConstraints) {
          if (constraint.theme === "Indice d'utilisation (IBUS)" && constraint.rule) {
            const extracted = extraireIndicesReglement(constraint.rule);
            if (extracted.indiceU) indices.indiceU = extracted.indiceU;
            if (extracted.indiceIBUS) indices.indiceIBUS = extracted.indiceIBUS;
          }
        }
        
        // 3. Depuis la zone de construction (buildingZone) - commenté car on n'utilise plus cette étape
        // if (analysis.buildingZone?.ibus && !indices.indiceIBUS) {
        //   indices.indiceIBUS = parseFloat(analysis.buildingZone.ibus);
        // }
        
        console.log(`📏 Indices extraits: U=${indices.indiceU}, IBUS=${indices.indiceIBUS}`);
        
        // Calculer la densité si on a trouvé au moins un indice
        if (indices.indiceU || indices.indiceIBUS) {
          analysis.valaisDensity = calculerDensiteValais({
            terrainSurface: terrainSurface,
            indiceU: indices.indiceU,
            indiceIBUS: indices.indiceIBUS,
            commune: municipality,
            projetCECB: false, // Par défaut, peut être modifié par l'utilisateur
            projetMINERGIE: false // Par défaut, peut être modifié par l'utilisateur
          });
          
          successCount++;
          console.log(`✅ Étape 5 réussie: Densité calculée: U=${analysis.valaisDensity.surfaceUtileU || 'N/A'} m², IBUS=${analysis.valaisDensity.surfaceUtileIBUS || 'N/A'} m²`);
        } else {
          console.log('❌ Étape 5 échouée: Aucun indice de construction trouvé dans les documents');
          analysis.errors.push('Indices de construction (U/IBUS) non trouvés');
        }
      }
    } catch (error) {
      const densityError = toErrorMessage(error);
      analysis.errors.push(`Erreur calcul densité: ${densityError}`);
      console.error('❌ Erreur calcul densité:', error);
    }
    
    // Pas d'analyse des dangers naturels pour l'instant (à implémenter plus tard)
    console.log('⚠️ Dangers naturels désactivés temporairement...');

    // Calcul de la complétude
    analysis.completeness = Math.round((successCount / totalSteps) * 100);
    analysis.processingTime = Date.now() - startTime;
    
    // Formatage pour OpenAI
    analysis.formattedForAI = formatForOpenAI(analysis);
    
    console.log(`✅ Analyse terminée en ${analysis.processingTime}ms - Complétude: ${analysis.completeness}%`);
    
  } catch (error) {
    console.error('❌ Erreur critique lors de l\'analyse:', error);
    analysis.errors.push(`Erreur critique: ${error}`);
    analysis.processingTime = Date.now() - startTime;
    analysis.formattedForAI = generateErrorMessage(searchQuery, analysis.errors);
  }
  
  return analysis;
}

/**
 * Formate toutes les données pour l'analyse OpenAI
 */
function formatForOpenAI(analysis: ComprehensiveParcelAnalysis): string {
  let formatted = `# ANALYSE COMPLÈTE DE PARCELLE\n\n`;
  formatted += `**Recherche:** ${analysis.searchQuery}\n`;
  formatted += `**Complétude des données:** ${analysis.completeness}%\n`;
  formatted += `**Temps de traitement:** ${analysis.processingTime}ms\n\n`;
  
  // 1. INFORMATIONS DE BASE
  if (analysis.searchResult && analysis.parcelDetails) {
    formatted += `## 1. INFORMATIONS DE BASE\n\n`;
    formatted += `**EGRID:** ${analysis.searchResult.egrid}\n`;
    formatted += `**Numéro de parcelle:** ${analysis.parcelDetails.number}\n`;
    formatted += `**Commune:** ${analysis.parcelDetails.municipality}\n`;
    formatted += `**Canton:** ${analysis.parcelDetails.canton}\n`;
    formatted += `**Surface:** ${analysis.parcelDetails.surface} m²\n`;
    formatted += `**Coordonnées:** ${analysis.parcelDetails.coordinates.x}, ${analysis.parcelDetails.coordinates.y} (CH1903+ LV95)\n\n`;
  }
  
  // 2. ZONE DE CONSTRUCTION
  if (Object.keys(analysis.buildingZone).length > 0) {
    formatted += `## 2. ZONE DE CONSTRUCTION\n\n`;
    const zone = analysis.buildingZone;
    if (zone.typ_kt) formatted += `**Type de zone:** ${zone.typ_kt}\n`;
    if (zone.description) formatted += `**Description:** ${zone.description}\n`;
    if (zone.nutzungszone) formatted += `**Zone d'affectation:** ${zone.nutzungszone}\n`;
    formatted += '\n';
  }
  
  // 3. RESTRICTIONS PLR
  if (analysis.plrData) {
    formatted += `## 3. RESTRICTIONS DE DROIT PUBLIC (PLR)\n\n`;
    formatted += formatPLRForAnalysis(analysis.plrData);
  }
  
  // 4. RÈGLEMENTS COMMUNAUX
  if (analysis.communalRegulations.length > 0) {
    formatted += `## 4. RÈGLEMENTS COMMUNAUX\n\n`;
    formatted += formatRegulationsForAnalysis(analysis.communalRegulations);
  }

  if (analysis.additionalData.length > 0) {
    formatted += formatAdditionalDataForAI(analysis.additionalData);
    formatted += '\n';
  }

  // 4b. TABLEAU DE CONTRAINTES FUSIONNÉES
  if (analysis.communalConstraints.length || analysis.rdppfConstraints.length || analysis.plrData || Object.keys(analysis.buildingZone).length) {
    formatted += `## 4b. SYNTHÈSE DES CONTRAINTES\n\n`;
    const merged: RegulationConstraint[] = [...analysis.communalConstraints, ...analysis.rdppfConstraints.map(c => ({ zone: '*', theme: c.theme, rule: c.rule }))];
    formatted += buildConstraintTable(merged, analysis.plrData, analysis.buildingZone);
    formatted += '\n';
  }
  
  // 4c. CALCULS DE DENSITÉ CONSTRUCTIBLE (VALAIS)
  if (analysis.valaisDensity) {
    formatted += `## 4c. DENSITÉ CONSTRUCTIBLE (VALAIS)\n\n`;
    formatted += formaterResultatsValais(analysis.valaisDensity);
  }
  
  // 5. CONTRAINTES GÉOGRAPHIQUES
  if (Object.keys(analysis.zones).length > 0 || Object.keys(analysis.geologicalInfo).length > 0) {
    formatted += `## 6. CONTRAINTES GÉOGRAPHIQUES ET GÉOLOGIQUES\n\n`;
    
    if (Object.keys(analysis.zones).length > 0) {
      formatted += `### Zones spéciales identifiées:\n`;
      for (const [layer, data] of Object.entries(analysis.zones)) {
        formatted += `- **${layer}:** ${JSON.stringify(data, null, 2)}\n`;
      }
      formatted += '\n';
    }
    
    if (Object.keys(analysis.geologicalInfo).length > 0) {
      formatted += `### Informations géologiques:\n`;
      for (const [layer, data] of Object.entries(analysis.geologicalInfo)) {
        formatted += `- **${layer}:** ${JSON.stringify(data, null, 2)}\n`;
      }
      formatted += '\n';
    }
  }
  
  // 7. ERREURS ET LIMITATIONS
  if (analysis.errors.length > 0) {
    formatted += `## 7. LIMITATIONS DE L'ANALYSE\n\n`;
    formatted += `**Données manquantes ou erreurs rencontrées:**\n`;
    for (const error of analysis.errors) {
      formatted += `- ${error}\n`;
    }
    formatted += '\n';
  }
  
  formatted += `---\n\n`;
  formatted += `**INSTRUCTIONS POUR L'ANALYSE:**\n`;
  formatted += `En tant qu'expert en aménagement du territoire et construction en Suisse, analysez ces données et fournissez:\n`;
  formatted += `1. Un résumé des principales contraintes et opportunités\n`;
  formatted += `2. Les démarches administratives nécessaires\n`;
  formatted += `3. Les points d'attention pour un projet de construction\n`;
  formatted += `4. Une estimation des risques et défis potentiels\n`;
  formatted += `5. Des recommandations spécifiques basées sur les données récoltées\n\n`;
  
  return formatted;
}

/**
 * Génère un message d'erreur formaté
 */
function generateErrorMessage(searchQuery: string, errors: string[]): string {
  let message = `# ERREUR D'ANALYSE DE PARCELLE\n\n`;
  message += `**Recherche:** ${searchQuery}\n\n`;
  message += `**Problèmes rencontrés:**\n`;
  for (const error of errors) {
    message += `- ${error}\n`;
  }
  message += `\n**Recommandations:**\n`;
  message += `- Vérifiez que l'adresse ou le numéro de parcelle est correct\n`;
  message += `- Essayez avec une formulation différente (ex: "Rue du Village 10, Sion" ou "Parcelle 542, Martigny")\n`;
  message += `- Contactez les services communaux pour obtenir des informations précises\n\n`;

  return message;
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
 * Analyse rapide (version allégée pour tests)
 */
export async function performQuickAnalysis(searchQuery: string): Promise<ComprehensiveParcelAnalysis> {
  console.log(`⚡ Analyse rapide pour: "${searchQuery}"`);
  
  const startTime = Date.now();
  const analysis: ComprehensiveParcelAnalysis = {
    searchQuery,
    searchResult: null,
    parcelDetails: null,
    geocodeResult: null,
    zones: {},
    geologicalInfo: {},
    buildingZone: {},
    plrData: null,
    communalRegulations: [],
    additionalData: [],
    communalConstraints: [],
    rdppfConstraints: [],
    valaisDensity: undefined,
    processingTime: 0,
    completeness: 0,
    errors: [],
    formattedForAI: ''
  };
  
  try {
    // Juste la recherche de base et quelques infos essentielles
    analysis.searchResult = await searchParcel(searchQuery);
    
    if (analysis.searchResult) {
      const { x, y } = analysis.searchResult.center;
      const egrid = analysis.searchResult.egrid;
      
      // Essayer de récupérer quelques données essentielles en parallèle
      const promises: Promise<any>[] = [
        getParcelDetails(x, y),
        getBuildingZoneInfo(x, y),
        identifyZonesAndConstraints(x, y)
      ];
      
      // Ajouter RDPPF si on a un EGRID
      if (egrid) {
        const rdppfUrl = `https://rdppfvs.geopol.ch/extract/pdf?EGRID=${egrid}&LANG=fr`;
        promises.push(analyzeRdppf(rdppfUrl).catch(err => {
          console.log(`⚠️ RDPPF rapide échoué: ${toErrorMessage(err)}`);
          return [];
        }));
      }
      
      const [parcelDetails, buildingZone, zones, rdppfConstraints] = await Promise.allSettled(promises);
      
      if (parcelDetails.status === 'fulfilled') analysis.parcelDetails = parcelDetails.value;
      if (buildingZone.status === 'fulfilled') analysis.buildingZone = buildingZone.value;
      if (zones.status === 'fulfilled') analysis.zones = zones.value;
      if (rdppfConstraints && rdppfConstraints.status === 'fulfilled') {
        analysis.rdppfConstraints = rdppfConstraints.value;
        
        // Extraire la zone depuis RDPPF
        const zoneConstraint = analysis.rdppfConstraints.find(c => c.theme === 'Destination de zone');
        if (zoneConstraint) {
          const zoneMatch = zoneConstraint.rule.match(/^([^,]+)/)
          if (zoneMatch) {
            const zoneDesignation = zoneMatch[1].trim();
            analysis.rdppfData = {
              zoneAffectation: {
                designation: zoneDesignation
              }
            };
            
            const surfaceMatch = zoneConstraint.rule.match(/Surface:\s*(\d+)\s*m²/);
            if (surfaceMatch) {
              analysis.rdppfData.zoneAffectation.surface = parseInt(surfaceMatch[1]);
            }
          }
        }
      }
      
      // Calcul de complétude approximatif
      let successCount = 1; // searchResult réussi
      if (analysis.parcelDetails) successCount++;
      if (Object.keys(analysis.buildingZone).length > 0) successCount++;
      if (Object.keys(analysis.zones).length > 0) successCount++;
      if (analysis.rdppfConstraints.length > 0) successCount++;
      
      analysis.completeness = Math.round((successCount / 5) * 100);
    }
    
    analysis.processingTime = Date.now() - startTime;
    analysis.formattedForAI = formatForOpenAI(analysis);
    
    console.log(`⚡ Analyse rapide terminée en ${analysis.processingTime}ms`);
    
  } catch (error) {
    analysis.errors.push(`Erreur analyse rapide: ${toErrorMessage(error)}`);
    analysis.formattedForAI = generateErrorMessage(searchQuery, analysis.errors);
  }
  
  return analysis;
} 