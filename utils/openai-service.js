// === SERVICE OPENAI UNIFIÉ ET OPTIMISÉ ===

const OpenAI = require('openai');
const { createContextLogger } = require('./logger');
const { aiAnalysisCache, generateCacheKey } = require('./cache-manager');

const aiLogger = createContextLogger('OPENAI');

// Configuration OpenAI centralisée
class OpenAIService {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY manquant dans les variables d\'environnement');
    }

    this.client = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY 
    });
    
    // Modèles supportés par ordre de préférence
    this.modelHierarchy = ['o3', 'o3-mini', 'o1', 'o1-mini', 'gpt-4o', 'gpt-4'];
    this.selectedModel = null;
    this.modelFeatures = new Map();
    
    // Initialiser les modèles disponibles
    this.initializeModels();
  }

  /**
   * Initialise la liste des modèles disponibles
   */
  async initializeModels() {
    try {
      const models = await this.client.models.list();
      const availableModels = models.data.map(m => m.id);
      
      // Sélectionner le meilleur modèle disponible
      for (const model of this.modelHierarchy) {
        if (availableModels.includes(model)) {
          this.selectedModel = model;
          aiLogger.info(`Modèle OpenAI sélectionné: ${model}`);
          break;
        }
      }

      if (!this.selectedModel) {
        this.selectedModel = 'gpt-4o';
        aiLogger.warn('Aucun modèle préféré trouvé, utilisation de gpt-4o par défaut');
      }

      // Définir les caractéristiques des modèles
      this.modelFeatures.set('o3', { reasoning: true, temperature: false, maxTokens: 100000 });
      this.modelFeatures.set('o3-mini', { reasoning: true, temperature: false, maxTokens: 50000 });
      this.modelFeatures.set('o1', { reasoning: true, temperature: false, maxTokens: 32768 });
      this.modelFeatures.set('o1-mini', { reasoning: true, temperature: false, maxTokens: 16384 });
      this.modelFeatures.set('gpt-4o', { reasoning: false, temperature: true, maxTokens: 4096 });
      this.modelFeatures.set('gpt-4', { reasoning: false, temperature: true, maxTokens: 4096 });

    } catch (error) {
      aiLogger.error('Erreur lors de l\'initialisation des modèles OpenAI:', error);
      this.selectedModel = 'gpt-4o'; // Fallback
    }
  }

  /**
   * Génère une clé de cache pour une requête
   */
  generateRequestCacheKey(prompt, model, options = {}) {
    return generateCacheKey('ai_request', {
      prompt: prompt.substring(0, 200), // Premiers 200 caractères
      model,
      ...options
    });
  }

  /**
   * Exécute une requête vers l'API OpenAI avec cache
   * @param {string} prompt - Prompt à envoyer
   * @param {object} options - Options de configuration
   * @returns {Promise<object>} Réponse de l'API
   */
  async completion(prompt, options = {}) {
    const startTime = Date.now();
    const model = options.model || this.selectedModel;
    const features = this.modelFeatures.get(model) || { reasoning: false, temperature: true };

    // Préparer la configuration de base
    const config = {
      model,
      messages: [{ role: 'user', content: prompt }],
      ...options
    };

    // Appliquer les paramètres selon le type de modèle
    if (features.reasoning) {
      // Modèles de raisonnement (o1, o3)
      if (model.startsWith('o1')) {
        config.reasoning_effort = options.reasoning_effort || 'medium';
      }
      // Pas de température pour les modèles de raisonnement
      delete config.temperature;
      delete config.max_tokens;
    } else {
      // Modèles GPT classiques
      config.temperature = options.temperature || 0.1;
      config.max_tokens = options.max_tokens || features.maxTokens;
    }

    // Vérifier le cache
    const cacheKey = this.generateRequestCacheKey(prompt, model, {
      temperature: config.temperature,
      reasoning_effort: config.reasoning_effort
    });

    try {
      // Essayer de récupérer depuis le cache
      const cachedResult = aiAnalysisCache.get(cacheKey);
      if (cachedResult) {
        aiLogger.debug(`Cache hit pour modèle ${model}`);
        return {
          ...cachedResult,
          cached: true,
          processingTime: Date.now() - startTime
        };
      }

      // Exécuter la requête
      aiLogger.debug(`Requête OpenAI: ${model}`, { 
        promptLength: prompt.length,
        reasoning: features.reasoning
      });

      const completion = await this.client.chat.completions.create(config);
      
      const result = {
        content: completion.choices[0].message.content,
        model: completion.model,
        usage: completion.usage,
        cached: false,
        processingTime: Date.now() - startTime
      };

      // Mettre en cache le résultat (1 heure)
      aiAnalysisCache.set(cacheKey, result, 3600);

      aiLogger.info(`Requête OpenAI complétée`, {
        model: completion.model,
        tokens: completion.usage?.total_tokens || 0,
        duration: result.processingTime
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      aiLogger.error(`Erreur OpenAI avec modèle ${model}:`, {
        error: error.message,
        duration,
        promptLength: prompt.length
      });

      // Tentative avec un modèle de fallback
      if (model !== 'gpt-4o' && options.allowFallback !== false) {
        aiLogger.warn(`Tentative avec modèle de fallback: gpt-4o`);
        return this.completion(prompt, { 
          ...options, 
          model: 'gpt-4o', 
          allowFallback: false 
        });
      }

      throw error;
    }
  }

  /**
   * Analyse spécialisée pour les contraintes urbanistiques
   * @param {object} data - Données de la parcelle
   * @returns {Promise<object>} Analyse structurée
   */
  async analyzeUrbanConstraints(data) {
    const prompt = this.buildUrbanAnalysisPrompt(data);
    
    const result = await this.completion(prompt, {
      temperature: 0, // Analyse factuelle
      reasoning_effort: 'high' // Pour les modèles o1/o3
    });

    try {
      const analysis = JSON.parse(result.content);
      return {
        ...analysis,
        metadata: {
          model_used: result.model,
          processing_time_ms: result.processingTime,
          tokens_used: result.usage?.total_tokens || 0,
          cached: result.cached
        }
      };
    } catch (parseError) {
      aiLogger.error('Erreur de parsing de l\'analyse IA:', parseError);
      throw new Error('Réponse IA non valide');
    }
  }

  /**
   * Construit le prompt spécialisé pour l'analyse urbanistique
   * @param {object} data - Données à analyser
   * @returns {string} Prompt formaté
   */
  buildUrbanAnalysisPrompt(data) {
    const { rdppfConstraints, zones, communalRegulations } = data;

    const parcelInfo = data.parcel || {
      address: data.searchQuery || 'Non spécifiée',
      commune: data.parcelDetails?.municipality || data.searchResult?.municipality || 'Non spécifiée'
    };

    const rdppfData = rdppfConstraints?.map(c =>
      `- ${c.title}: ${c.description} (${c.severity})`
    ).join('\n') || 'Aucune contrainte RDPPF détectée';

    let zoneData = 'Zonage non déterminé';
    if (zones && Object.keys(zones).length > 0) {
      zoneData = Object.entries(zones).map(([zone, info]) =>
        `- Zone ${zone}: ${info.description || info.nutzungszone || 'Description non disponible'}`
      ).join('\n');
    } else if (data.rdppfData?.zoneAffectation?.designation) {
      zoneData = `- ${data.rdppfData.zoneAffectation.designation}`;
    } else if (data.buildingZone?.nutzungszone) {
      zoneData = `- ${data.buildingZone.nutzungszone}`;
    }

    const regulationData = communalRegulations?.map(r =>
      `- ${r.title}: ${r.content}`
    ).join('\n') || 'Règlement communal non analysé';

    return `Vous êtes un expert urbaniste suisse spécialisé dans l'analyse de contraintes réglementaires.

DONNÉES DE LA PARCELLE :
Adresse: ${parcelInfo.address}
Commune: ${parcelInfo.commune}

CONTRAINTES RDPPF :
${rdppfData}

ZONAGE :
${zoneData}

RÈGLEMENT COMMUNAL :
${regulationData}

INSTRUCTION :
Analysez ces données et fournissez une réponse JSON structurée avec les champs suivants :

{
  "analysis": {
    "commune": "string",
    "parcelles": [{
      "numero": "string",
      "surface_totale_m2": number,
      "zones": {
        "CODE_ZONE": {
          "denomination": "string",
          "surface_m2": number,
          "indice_IBUS": number,
          "surface_utilisable_m2": number,
          "distance_min_m": number,
          "distance_normale": "string",
          "hauteur_max_m": number,
          "niveaux": "string",
          "gabarits_longueur_m": number|null,
          "gabarits_largeur_m": number|null,
          "toiture_pans": string|null,
          "toiture_pentes": string|null
        }
      }
    }],
    "places_de_parc": {
      "habitation_ratio": number,
      "remarques": "string"
    },
    "places_de_jeux": {
      "surface_par_logement_m2": number|null,
      "surface_max_terrain_unique_m2": number|null,
      "condition": "string"
    },
    "reglement_communal_resume": {
      "alignement_facades": "string",
      "affectation_principale": "string"
    },
    "contraintes_supplementaires": [{
      "type": "string",
      "description": "string",
      "impact": "faible|moyen|élevé"
    }]
  },
  "constraints": [{
    "title": "string",
    "description": "string",
    "severity": "low|medium|high",
    "source": "string",
    "icon": "emoji"
  }]
}

Répondez UNIQUEMENT avec le JSON, sans texte supplémentaire.`;
  }

  /**
   * Récupère les statistiques d'utilisation
   * @returns {object} Statistiques
   */
  getUsageStats() {
    return {
      selectedModel: this.selectedModel,
      availableModels: Array.from(this.modelFeatures.keys()),
      cacheStats: aiAnalysisCache.getStats()
    };
  }
}

// Instance singleton
let openAIServiceInstance = null;

/**
 * Récupère l'instance du service OpenAI
 * @returns {OpenAIService} Instance du service
 */
function getOpenAIService() {
  if (!openAIServiceInstance) {
    openAIServiceInstance = new OpenAIService();
  }
  return openAIServiceInstance;
}

module.exports = {
  OpenAIService,
  getOpenAIService
};