/* =========================================================
   BâtiPilot — Données de démonstration
   ---------------------------------------------------------
   Ce fichier ne contient QUE des données simulées.
   Il sera supprimé le jour où l'API réelle est branchée
   (voir js/api.js → ERP.Api.config.mode = 'http').
   ========================================================= */
window.ERP = window.ERP || {};

(function (ERP) {
  'use strict';

  /* ---------- Date de référence de la démo -------------------------
     Mettre `new Date()` pour utiliser la vraie date du jour.        */
  const TODAY = '2026-08-14';

  /* ---------- Utilitaires de date ---------- */
  const dt = {
    today: () => TODAY,
    parse: (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); },
    iso: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    add: (s, n) => { const d = dt.parse(s); d.setDate(d.getDate() + n); return dt.iso(d); },
    diff: (a, b) => Math.round((dt.parse(b) - dt.parse(a)) / 86400000),
    isWeekend: (s) => [0, 6].includes(dt.parse(s).getDay())
  };

  /* ---------- Générateur pseudo-aléatoire déterministe ----------
     Même jeu de données à chaque rechargement.                  */
  function seeded(seed) {
    let a = seed >>> 0;
    return function () {
      a += 0x6D2B79F5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  /* =======================================================
     UTILISATEUR
     ======================================================= */
  const user = {
    id: 'U-01', firstName: 'Ahmed', name: 'Ahmed Ben Ali', initials: 'AB',
    role: 'Chef de projet', email: 'a.benali@batipilot.tn', phone: '+216 98 412 337',
    agency: 'Agence Grand Tunis', since: '2019-04-01'
  };

  /* =======================================================
     CLIENTS (20)
     ======================================================= */
  const CLIENT_ROWS = [
    // [contact, société, ville, tel, email, statut, depuis]
    ['Slim Trabelsi', 'Société ABC Immobilier', 'Tunis', '71 842 100', 'contact@abc-immo.tn', 'actif', '2021-03-12'],
    ['Mohamed Ben Ali', 'Ben Ali Investissements', 'La Marsa', '71 774 902', 'm.benali@bai.tn', 'actif', '2023-06-02'],
    ['Leïla Mansouri', 'Carthage Développement', 'Carthage', '71 730 445', 'l.mansouri@carthagedev.tn', 'actif', '2020-09-18'],
    ['Hédi Gharbi', 'Immobilière El Yasmine', 'Tunis', '71 890 220', 'h.gharbi@elyasmine.tn', 'actif', '2019-11-05'],
    ['Sonia Belhaj', 'Municipalité de Sousse', 'Sousse', '73 224 800', 's.belhaj@commune-sousse.tn', 'actif', '2025-12-01'],
    ['Karim Jelassi', 'Sahara Agro-Industries', 'Sfax', '74 402 615', 'k.jelassi@saharagro.tn', 'actif', '2022-02-14'],
    ['Nizar Chaabane', 'Marina Resorts Hammamet', 'Hammamet', '72 281 340', 'n.chaabane@marinaresorts.tn', 'actif', '2024-05-20'],
    ['Faouzi Mzali', 'Groupe Medina Invest', 'Bizerte', '72 431 077', 'f.mzali@medinainvest.tn', 'actif', '2026-01-09'],
    ['Rania Khediri', 'Tunisie Habitat Plus', 'Ariana', '71 706 512', 'r.khediri@habitatplus.tn', 'actif', '2021-07-30'],
    ['Wassim Bouazizi', 'SOPROMED Promotion', 'Nabeul', '72 220 908', 'w.bouazizi@sopromed.tn', 'actif', '2020-04-22'],
    ['Imen Farhat', 'Résidences Ennour', 'Monastir', '73 461 233', 'i.farhat@ennour.tn', 'inactif', '2019-02-11'],
    ['Ali Zouaoui', 'Bâti-Sud Constructions', 'Gabès', '75 271 604', 'a.zouaoui@batisud.tn', 'actif', '2022-10-03'],
    ['Nadia Riahi', 'Clinique El Amen Nord', 'Ariana', '71 810 470', 'n.riahi@amennord.tn', 'prospect', '2026-05-14'],
    ['Sofiane Kacem', 'Kacem Frères Négoce', 'Sfax', '74 226 118', 's.kacem@kacemfreres.tn', 'actif', '2023-01-27'],
    ['Amel Ben Youssef', 'Groupe Scolaire Al Kindi', 'Tunis', '71 285 663', 'direction@alkindi.tn', 'actif', '2024-08-16'],
    ['Tarek Haddad', 'Haddad Logistique', 'Radès', '71 449 205', 't.haddad@haddadlog.tn', 'actif', '2021-12-09'],
    ['Salma Bouzid', 'Yasmine Retail Park', 'Hammamet', '72 245 771', 's.bouzid@yasmineretail.tn', 'prospect', '2026-06-03'],
    ['Habib Ouertani', 'Société Immobilière du Nord', 'Bizerte', '72 400 310', 'h.ouertani@sin.tn', 'actif', '2020-06-15'],
    ['Yosra Chebbi', 'Clinique Dentaire Chebbi', 'La Soukra', '71 866 924', 'y.chebbi@dentaire.tn', 'actif', '2025-03-28'],
    ['Mounir Sassi', 'Sassi Industries', 'Ben Arous', '71 380 546', 'm.sassi@sassi-ind.tn', 'inactif', '2018-10-01']
  ];
  const clients = CLIENT_ROWS.map((r, i) => ({
    id: 'CLI-' + String(i + 1).padStart(3, '0'),
    contact: r[0], company: r[1], city: r[2],
    phone: '+216 ' + r[3], email: r[4], status: r[5], since: r[6],
    address: `${['Rue de la Liberté', 'Avenue Habib Bourguiba', 'Rue Ibn Khaldoun', 'Avenue de la République', 'Rue du Lac Léman'][i % 5]} ${10 + i * 3}, ${r[2]}`
  }));

  /* =======================================================
     PROJETS — 8 en activité + 12 terminés
     ======================================================= */
  const projects = [
    {
      id: 'PRJ-001', ref: 'CHT-2026-001', name: 'Résidence Les Jardins', clientId: 'CLI-001',
      address: 'Cité Ennasr II, Ariana', city: 'Ariana', manager: 'Ahmed Ben Ali',
      start: '2026-02-12', end: '2026-09-30', status: 'en_cours', progress: 72,
      budget: 320000, spent: 230400, type: 'Logements collectifs — 3 blocs / 42 appartements',
      phases: [
        { name: 'Gros œuvre', start: '2026-02-12', end: '2026-05-30', progress: 100, lead: 'Mohamed Ali Ben Salah' },
        { name: 'Électricité', start: '2026-05-15', end: '2026-08-11', progress: 78, lead: 'Sami Ben Amor' },
        { name: 'Plomberie', start: '2026-06-01', end: '2026-09-05', progress: 62, lead: 'Nabil Gharbi' },
        { name: 'Finitions', start: '2026-08-01', end: '2026-09-30', progress: 24, lead: 'Hatem Zouari' }
      ]
    },
    {
      id: 'PRJ-002', ref: 'CHT-2026-002', name: 'Villa Ben Ali', clientId: 'CLI-002',
      address: 'Route de Gammarth, La Marsa', city: 'La Marsa', manager: 'Ahmed Ben Ali',
      start: '2026-03-15', end: '2026-08-31', status: 'en_retard', progress: 61,
      budget: 145000, spent: 119000, type: 'Villa individuelle R+1 avec piscine',
      phases: [
        { name: 'Gros œuvre', start: '2026-03-15', end: '2026-06-10', progress: 100, lead: 'Khaled Trabelsi' },
        { name: 'Électricité', start: '2026-06-01', end: '2026-07-25', progress: 85, lead: 'Sami Ben Amor' },
        { name: 'Plomberie', start: '2026-06-10', end: '2026-08-05', progress: 70, lead: 'Anis Mabrouk' },
        { name: 'Finitions', start: '2026-07-15', end: '2026-08-31', progress: 30, lead: 'Youssef Sassi' }
      ]
    },
    {
      id: 'PRJ-003', ref: 'CHT-2026-003', name: 'Centre commercial Carthage Plaza', clientId: 'CLI-003',
      address: 'Avenue de Carthage, Carthage', city: 'Carthage', manager: 'Sonia Belhaj',
      start: '2026-01-05', end: '2027-02-28', status: 'en_cours', progress: 48,
      budget: 280000, spent: 190400, type: 'Centre commercial — 8 400 m² sur 2 niveaux',
      phases: [
        { name: 'Gros œuvre', start: '2026-01-05', end: '2026-08-15', progress: 88, lead: 'Bilel Haddad' },
        { name: 'Électricité', start: '2026-07-01', end: '2026-11-30', progress: 22, lead: 'Ridha Ben Youssef' },
        { name: 'Plomberie', start: '2026-07-15', end: '2026-11-15', progress: 18, lead: 'Slim Nasri' },
        { name: 'Finitions', start: '2026-10-01', end: '2027-02-15', progress: 0, lead: 'Fethi Chaouch' }
      ]
    },
    {
      id: 'PRJ-004', ref: 'CHT-2025-014', name: 'Immeuble El Manar', clientId: 'CLI-004',
      address: 'El Manar I, Tunis', city: 'Tunis', manager: 'Ahmed Ben Ali',
      start: '2025-10-20', end: '2026-09-30', status: 'en_retard', progress: 55,
      budget: 165000, spent: 135300, type: 'Immeuble R+4 — 16 appartements',
      phases: [
        { name: 'Gros œuvre', start: '2025-10-20', end: '2026-02-28', progress: 100, lead: 'Lotfi Bouzid' },
        { name: 'Électricité', start: '2026-03-01', end: '2026-06-30', progress: 62, lead: 'Walid Khelifi' },
        { name: 'Plomberie', start: '2026-03-15', end: '2026-07-31', progress: 58, lead: 'Mehdi Jaziri' },
        { name: 'Finitions', start: '2026-06-01', end: '2026-09-30', progress: 12, lead: 'Karim Ayadi' }
      ]
    },
    {
      id: 'PRJ-005', ref: 'CHT-2026-004', name: 'Complexe sportif Sousse', clientId: 'CLI-005',
      address: 'Zone sportive, Sousse Nord', city: 'Sousse', manager: 'Sonia Belhaj',
      start: '2026-09-01', end: '2027-06-30', status: 'en_preparation', progress: 12,
      budget: 90000, spent: 10800, type: 'Salle omnisports 1 200 places',
      phases: [
        { name: 'Terrassement', start: '2026-09-01', end: '2026-10-15', progress: 0, lead: 'Aymen Dridi' },
        { name: 'Gros œuvre', start: '2026-09-20', end: '2027-02-28', progress: 0, lead: 'Tarek Ben Hassine' },
        { name: 'Électricité', start: '2027-01-05', end: '2027-04-30', progress: 0, lead: 'Hamza Souissi' },
        { name: 'Finitions', start: '2027-04-01', end: '2027-06-30', progress: 0, lead: 'Chokri Rekik' }
      ]
    },
    {
      id: 'PRJ-006', ref: 'CHT-2026-005', name: 'Extension usine agro Sfax', clientId: 'CLI-006',
      address: 'Zone industrielle Poudrière, Sfax', city: 'Sfax', manager: 'Karim Jelassi',
      start: '2026-03-10', end: '2026-11-15', status: 'en_cours', progress: 74,
      budget: 120000, spent: 90700, type: 'Hangar industriel 2 200 m² + quai de chargement',
      phases: [
        { name: 'Gros œuvre', start: '2026-03-10', end: '2026-07-20', progress: 100, lead: 'Marwen Ferchichi' },
        { name: 'Charpente métallique', start: '2026-06-15', end: '2026-09-10', progress: 76, lead: 'Zied Ben Romdhane' },
        { name: 'Électricité', start: '2026-07-01', end: '2026-10-20', progress: 54, lead: 'Oussama Guesmi' },
        { name: 'Finitions', start: '2026-09-15', end: '2026-11-15', progress: 8, lead: 'Adel Mejri' }
      ]
    },
    {
      id: 'PRJ-007', ref: 'CHT-2026-006', name: 'Hôtel Marina — rénovation', clientId: 'CLI-007',
      address: 'Marina Yasmine, Hammamet', city: 'Hammamet', manager: 'Ahmed Ben Ali',
      start: '2026-01-15', end: '2026-09-30', status: 'en_cours', progress: 66,
      budget: 85000, spent: 68000, type: 'Rénovation de 64 chambres + espaces communs',
      phases: [
        { name: 'Démolition', start: '2026-01-15', end: '2026-03-05', progress: 100, lead: 'Sofien Ben Salem' },
        { name: 'Plomberie', start: '2026-02-20', end: '2026-06-30', progress: 92, lead: 'Imed Kacem' },
        { name: 'Électricité', start: '2026-03-01', end: '2026-07-31', progress: 88, lead: 'Jalel Ouertani' },
        { name: 'Finitions', start: '2026-06-01', end: '2026-09-30', progress: 41, lead: 'Moez Baccouche' }
      ]
    },
    {
      id: 'PRJ-008', ref: 'CHT-2026-007', name: 'Lotissement Erriadh', clientId: 'CLI-008',
      address: 'Erriadh, Bizerte Sud', city: 'Bizerte', manager: 'Faouzi Mzali',
      start: '2026-08-01', end: '2027-05-31', status: 'en_preparation', progress: 15,
      budget: 45000, spent: 5400, type: 'Viabilisation de 36 lots + voirie',
      phases: [
        { name: 'Études & bornage', start: '2026-08-01', end: '2026-09-15', progress: 55, lead: 'Nizar Hamdi' },
        { name: 'Terrassement', start: '2026-09-10', end: '2026-12-20', progress: 0, lead: 'Rafik Sghaier' },
        { name: 'Réseaux', start: '2026-11-01', end: '2027-03-15', progress: 0, lead: 'Skander Ayari' },
        { name: 'Voirie', start: '2027-02-01', end: '2027-05-31', progress: 0, lead: 'Taoufik Ben Ammar' }
      ]
    }
  ];

  /* --- 12 projets terminés (historique) --- */
  const DONE_ROWS = [
    ['Résidence Al Amal', 'CLI-009', 'Ariana', 210000, '2024-02-05', '2025-01-20'],
    ['Villa Trabelsi', 'CLI-001', 'La Soukra', 98000, '2024-05-12', '2024-12-18'],
    ['Dépôt logistique Radès', 'CLI-016', 'Radès', 176000, '2024-01-08', '2024-10-30'],
    ['Groupe scolaire Al Kindi', 'CLI-015', 'Tunis', 143000, '2024-07-01', '2025-06-15'],
    ['Clinique dentaire Chebbi', 'CLI-019', 'La Soukra', 64000, '2025-03-03', '2025-09-12'],
    ['Immeuble Ennour', 'CLI-011', 'Monastir', 152000, '2023-09-11', '2024-11-05'],
    ['Siège Kacem Frères', 'CLI-014', 'Sfax', 118000, '2024-04-15', '2025-03-28'],
    ['Résidence Les Oliviers', 'CLI-010', 'Nabeul', 187000, '2024-06-20', '2025-08-10'],
    ['Entrepôt Sassi Industries', 'CLI-020', 'Ben Arous', 96000, '2023-11-06', '2024-08-22'],
    ['Villa Mzali', 'CLI-008', 'Bizerte', 88000, '2025-01-15', '2025-10-04'],
    ['Résidence du Lac', 'CLI-004', 'Tunis', 234000, '2024-03-01', '2025-05-30'],
    ['Centre médical Bâti-Sud', 'CLI-012', 'Gabès', 105000, '2025-02-10', '2026-01-15']
  ];
  DONE_ROWS.forEach((r, i) => {
    projects.push({
      id: 'PRJ-' + String(100 + i), ref: 'CHT-ARCH-' + String(i + 1).padStart(3, '0'),
      name: r[0], clientId: r[1], address: r[2], city: r[2], manager: 'Ahmed Ben Ali',
      start: r[4], end: r[5], status: 'termine', progress: 100,
      budget: r[3], spent: Math.round(r[3] * (0.92 + (i % 5) * 0.02)), type: 'Projet livré et réceptionné',
      phases: [{ name: 'Chantier complet', start: r[4], end: r[5], progress: 100, lead: 'Ahmed Ben Ali' }]
    });
  });

  /* =======================================================
     OUVRIERS (50)
     ======================================================= */
  const WORKER_ROWS = [
    'Mohamed Ali Ben Salah|Chef d\'équipe|PRJ-001', 'Sami Ben Amor|Électricien|PRJ-001',
    'Khaled Trabelsi|Maçon|PRJ-002', 'Nabil Gharbi|Plombier|PRJ-001',
    'Anis Mabrouk|Plombier|PRJ-002', 'Hatem Zouari|Peintre|PRJ-001',
    'Youssef Sassi|Carreleur|PRJ-002', 'Bilel Haddad|Chef d\'équipe|PRJ-003',
    'Ridha Ben Youssef|Électricien|PRJ-003', 'Slim Nasri|Plombier|PRJ-003',
    'Fethi Chaouch|Peintre|PRJ-003', 'Lotfi Bouzid|Coffreur|PRJ-004',
    'Walid Khelifi|Électricien|PRJ-004', 'Mehdi Jaziri|Plombier|PRJ-004',
    'Karim Ayadi|Plâtrier|PRJ-004', 'Aymen Dridi|Conducteur d\'engin|PRJ-005',
    'Tarek Ben Hassine|Maçon|PRJ-005', 'Hamza Souissi|Électricien|PRJ-005',
    'Chokri Rekik|Menuisier|PRJ-005', 'Marwen Ferchichi|Chef d\'équipe|PRJ-006',
    'Zied Ben Romdhane|Soudeur|PRJ-006', 'Oussama Guesmi|Électricien|PRJ-006',
    'Adel Mejri|Peintre|PRJ-006', 'Sofien Ben Salem|Manœuvre|PRJ-007',
    'Imed Kacem|Plombier|PRJ-007', 'Jalel Ouertani|Électricien|PRJ-007',
    'Moez Baccouche|Carreleur|PRJ-007', 'Nizar Hamdi|Géomètre|PRJ-008',
    'Rafik Sghaier|Conducteur d\'engin|PRJ-008', 'Skander Ayari|Maçon|PRJ-008',
    'Taoufik Ben Ammar|Manœuvre|PRJ-008', 'Wajdi Louati|Ferrailleur|PRJ-001',
    'Yassine Chebbi|Maçon|PRJ-001', 'Amine Ben Cheikh|Coffreur|PRJ-001',
    'Bechir Zaidi|Manœuvre|PRJ-001', 'Chedly Mansour|Maçon|PRJ-003',
    'Dhia Ben Slimane|Ferrailleur|PRJ-003', 'Elyes Hammami|Grutier|PRJ-003',
    'Firas Bouzidi|Manœuvre|PRJ-003', 'Ghazi Toumi|Coffreur|PRJ-003',
    'Hichem Ben Abdallah|Maçon|PRJ-004', 'Issam Douzi|Manœuvre|PRJ-004',
    'Jaber Mathlouthi|Étancheur|PRJ-004', 'Kamel Riahi|Soudeur|PRJ-006',
    'Lassaad Ben Fraj|Manœuvre|PRJ-006', 'Makrem Selmi|Menuisier|PRJ-006',
    'Nader Bettaieb|Peintre|PRJ-007', 'Omar Jendoubi|Plâtrier|PRJ-007',
    'Riadh Hamrouni|Maçon|PRJ-002', 'Sabri Ben Othman|Manœuvre|PRJ-002'
  ];
  const RATE = {
    'Chef d\'équipe': 22, 'Maçon': 16, 'Coffreur': 17, 'Ferrailleur': 17, 'Électricien': 19,
    'Plombier': 19, 'Peintre': 15, 'Carreleur': 16, 'Menuisier': 18, 'Soudeur': 20,
    'Grutier': 21, 'Conducteur d\'engin': 20, 'Manœuvre': 12, 'Plâtrier': 15,
    'Étancheur': 17, 'Géomètre': 24
  };
  const workers = WORKER_ROWS.map((row, i) => {
    const [name, trade, projectId] = row.split('|');
    const rnd = seeded(hash(name));
    return {
      id: 'OUV-' + String(i + 1).padStart(3, '0'),
      matricule: 'M' + String(1240 + i * 3),
      name, trade, projectId,
      phone: '+216 ' + (20 + Math.floor(rnd() * 79)) + ' ' + String(Math.floor(rnd() * 900) + 100) + ' ' + String(Math.floor(rnd() * 900) + 100),
      rate: RATE[trade] || 15,
      cnss: 'CNSS-' + String(80000 + i * 137),
      since: `20${19 + (i % 7)}-${String(1 + (i % 12)).padStart(2, '0')}-05`,
      contract: i % 6 === 0 ? 'CDI' : (i % 3 === 0 ? 'CDD' : 'Journalier')
    };
  });

  /* =======================================================
     ARTICLES / MATÉRIAUX (40)
     ======================================================= */
  const ARTICLE_ROWS = [
    // [désignation, catégorie, unité, stock, seuil, prix, fournisseur]
    ['Ciment CEM II 25 kg', 'Gros œuvre', 'sac', 320, 200, 12.5, 'Ciments de Bizerte'],
    ['Ciment blanc 25 kg', 'Gros œuvre', 'sac', 46, 60, 21.0, 'Ciments de Bizerte'],
    ['Sable de carrière', 'Gros œuvre', 'm³', 84, 40, 38.0, 'Carrières du Nord'],
    ['Sable de mer lavé', 'Gros œuvre', 'm³', 22, 30, 44.0, 'Carrières du Nord'],
    ['Gravier 8/15', 'Gros œuvre', 'm³', 61, 35, 42.0, 'Carrières du Nord'],
    ['Gravier 15/25', 'Gros œuvre', 'm³', 0, 25, 41.0, 'Carrières du Nord'],
    ['Brique 12 trous', 'Gros œuvre', 'unité', 12400, 5000, 0.85, 'Briqueterie El Fejja'],
    ['Brique 8 trous', 'Gros œuvre', 'unité', 3800, 4000, 0.72, 'Briqueterie El Fejja'],
    ['Hourdis 16', 'Gros œuvre', 'unité', 950, 600, 2.4, 'Préfa Manouba'],
    ['Béton prêt B25', 'Gros œuvre', 'm³', 0, 10, 168.0, 'BétonPlus Tunisie'],
    ['Fer à béton Ø8', 'Ferraillage', 'barre', 410, 250, 14.2, 'Sidérurgie El Fouladh'],
    ['Fer à béton Ø10', 'Ferraillage', 'barre', 265, 200, 19.6, 'Sidérurgie El Fouladh'],
    ['Fer à béton Ø12', 'Ferraillage', 'barre', 180, 200, 27.4, 'Sidérurgie El Fouladh'],
    ['Fer à béton Ø14', 'Ferraillage', 'barre', 92, 80, 36.8, 'Sidérurgie El Fouladh'],
    ['Fer à béton Ø16', 'Ferraillage', 'barre', 38, 60, 48.5, 'Sidérurgie El Fouladh'],
    ['Treillis soudé 6 m²', 'Ferraillage', 'panneau', 74, 40, 62.0, 'Sidérurgie El Fouladh'],
    ['Fil de ligature 1 kg', 'Ferraillage', 'kg', 145, 60, 3.9, 'Quincaillerie Zitouna'],
    ['Câble 3G2,5 (couronne 100 m)', 'Électricité', 'couronne', 28, 15, 186.0, 'Électro Médina'],
    ['Câble 3G1,5 (couronne 100 m)', 'Électricité', 'couronne', 34, 15, 124.0, 'Électro Médina'],
    ['Gaine ICTA Ø20 (25 m)', 'Électricité', 'rouleau', 62, 30, 21.5, 'Électro Médina'],
    ['Tableau électrique 24 modules', 'Électricité', 'unité', 9, 10, 148.0, 'Électro Médina'],
    ['Disjoncteur 16 A', 'Électricité', 'unité', 120, 50, 18.4, 'Électro Médina'],
    ['Prise encastrée 16 A', 'Électricité', 'unité', 240, 100, 7.8, 'Électro Médina'],
    ['Interrupteur simple', 'Électricité', 'unité', 186, 100, 6.9, 'Électro Médina'],
    ['Tube PVC Ø100 (4 m)', 'Plomberie', 'barre', 96, 50, 32.0, 'Plasto Sfax'],
    ['Tube PVC Ø50 (4 m)', 'Plomberie', 'barre', 128, 60, 17.5, 'Plasto Sfax'],
    ['Tube PPR Ø25 (4 m)', 'Plomberie', 'barre', 74, 60, 14.8, 'Plasto Sfax'],
    ['Coude PVC Ø100', 'Plomberie', 'unité', 210, 80, 4.6, 'Plasto Sfax'],
    ['Robinet d\'arrêt 1/2"', 'Plomberie', 'unité', 58, 40, 12.2, 'Plasto Sfax'],
    ['WC complet céramique', 'Plomberie', 'unité', 14, 12, 235.0, 'Sanitaire El Menzah'],
    ['Peinture acrylique blanche 20 L', 'Finition', 'seau', 41, 25, 128.0, 'Peintures Carthage'],
    ['Peinture façade 20 L', 'Finition', 'seau', 18, 20, 176.0, 'Peintures Carthage'],
    ['Enduit de lissage 25 kg', 'Finition', 'sac', 88, 50, 18.9, 'Peintures Carthage'],
    ['Carrelage 60×60 grès', 'Finition', 'm²', 640, 300, 34.0, 'Céramique Nabeul'],
    ['Faïence 25×40', 'Finition', 'm²', 210, 150, 24.5, 'Céramique Nabeul'],
    ['Colle à carrelage 25 kg', 'Finition', 'sac', 132, 80, 16.4, 'Céramique Nabeul'],
    ['Porte intérieure bois', 'Menuiserie', 'unité', 26, 20, 285.0, 'Menuiserie Ben Slimane'],
    ['Fenêtre alu 1,2×1,2 m', 'Menuiserie', 'unité', 11, 15, 420.0, 'Alu Design Tunis'],
    ['Membrane d\'étanchéité 10 m²', 'Étanchéité', 'rouleau', 24, 20, 168.0, 'Étanche Pro'],
    ['Gasoil groupe électrogène', 'Équipement', 'litre', 480, 300, 2.5, 'Station Sud Carburants']
  ];
  /* =========================================================
     FOURNISSEURS
     Chaque article est rattaché à un fournisseur ; les matériaux
     « à la une » sont ceux que le chef de projet commande en priorité.
     ========================================================= */
  const SUPPLIER_ROWS = [
    // [raison sociale, interlocuteur, téléphone, e-mail, adresse, ville, spécialité, délai (j), note /5]
    ['Ciments de Bizerte', 'Slim Chaabane', '+216 72 430 118', 'commercial@cimentsbizerte.tn', 'Zone industrielle, route de Tunis', 'Bizerte', 'Liants et ciments', 3, 4.6],
    ['Carrières du Nord', 'Nizar Ouertani', '+216 78 512 640', 'ventes@carrieresdunord.tn', 'Route de Béja km 8', 'Jendouba', 'Granulats et sables', 2, 4.2],
    ['Sidérurgie El Fouladh', 'Ridha Belkhiria', '+216 72 386 900', 'contact@elfouladh.com.tn', 'Menzel Bourguiba, zone portuaire', 'Bizerte', 'Ferraillage et treillis', 5, 4.4],
    ['Briqueterie El Fejja', 'Mounir Jendoubi', '+216 71 645 230', 'commande@briqueteriefejja.tn', 'El Fejja, route de Zaghouan', 'Manouba', 'Briques et hourdis', 2, 3.9],
    ['BétonPlus Tunisie', 'Faten Trabelsi', '+216 71 902 455', 'bpe@betonplus.tn', 'Centrale à béton, Mghira', 'Ben Arous', 'Béton prêt à l\'emploi', 1, 4.8],
    ['Préfa Manouba', 'Hichem Gharbi', '+216 71 604 812', 'devis@prefamanouba.tn', 'Zone industrielle Douar Hicher', 'Manouba', 'Éléments préfabriqués', 6, 3.7],
    ['Électro Médina', 'Sonia Ben Romdhane', '+216 71 337 902', 'pro@electromedina.tn', '14 rue de Marseille', 'Tunis', 'Matériel électrique', 2, 4.5],
    ['Plasto Sfax', 'Anouar Kammoun', '+216 74 611 350', 'ventes@plastosfax.tn', 'Route de Gabès km 4', 'Sfax', 'Tubes et raccords PVC', 4, 4.1],
    ['Sanitaire El Menzah', 'Leila Mrabet', '+216 71 236 448', 'showroom@sanitairemenzah.tn', 'Avenue Hédi Nouira, El Menzah 6', 'Tunis', 'Sanitaire et robinetterie', 3, 4.3],
    ['Céramique Nabeul', 'Karim Zouaoui', '+216 72 285 117', 'export@ceramiquenabeul.tn', 'Route de Hammamet km 3', 'Nabeul', 'Carrelage et faïence', 4, 4.7],
    ['Peintures Carthage', 'Yassine Haddad', '+216 71 771 265', 'commercial@peinturescarthage.tn', 'Zone industrielle Charguia II', 'Ariana', 'Peintures et enduits', 2, 4.0],
    ['Alu Design Tunis', 'Skander Ayari', '+216 71 428 733', 'projets@aludesign.tn', 'Route de Bizerte km 12', 'Ariana', 'Menuiserie aluminium', 12, 3.8],
    ['Menuiserie Ben Slimane', 'Habib Ben Slimane', '+216 73 342 906', 'atelier@menuiseriebs.tn', 'Zone artisanale, Msaken', 'Sousse', 'Menuiserie bois', 10, 4.4],
    ['Étanche Pro', 'Amine Chérif', '+216 71 860 214', 'technique@etanchepro.tn', 'Rue de l\'Artisanat, Ben Arous', 'Ben Arous', 'Étanchéité et isolation', 3, 4.2],
    ['Quincaillerie Zitouna', 'Nabil Zitouna', '+216 71 561 099', 'quincaillerie.zitouna@gnet.tn', '32 avenue de la République', 'Tunis', 'Quincaillerie générale', 1, 4.1],
    ['Station Sud Carburants', 'Walid Msakni', '+216 75 224 780', 'pro@stationsud.tn', 'Route de Médenine', 'Gabès', 'Carburants et lubrifiants', 1, 3.6],
    ['Dépôt Sfax', 'Imed Chaari', '+216 74 402 118', 'depot.sfax@materiaux.tn', 'Route de Tunis km 6', 'Sfax', 'Matériaux généraux', 2, 3.9]
  ];

  const suppliers = SUPPLIER_ROWS.map((r, i) => ({
    id: 'FRN-' + String(i + 1).padStart(3, '0'),
    company: r[0], contact: r[1], phone: r[2], email: r[3],
    address: r[4], city: r[5], specialty: r[6],
    leadDays: r[7], rating: r[8],
    taxId: `${1200000 + i * 137}/A/M/000`,
    payment: ['30 jours fin de mois', 'Comptant à la livraison', '45 jours', '60 jours fin de mois'][i % 4],
    since: dt.add(TODAY, -(400 + i * 53)),
    status: i % 9 === 4 ? 'occasionnel' : 'actif',
    featured: [],          // matériaux à la une, renseignés après création des articles
    note: ''
  }));

  const supplierByName = (name) => suppliers.find(s => s.company === name);

  const articles = ARTICLE_ROWS.map((r, i) => {
    const stock = r[3], min = r[4];
    const sup = supplierByName(r[6]);
    return {
      id: 'ART-' + String(i + 1).padStart(3, '0'),
      ref: 'MAT-' + String(i + 1).padStart(4, '0'),
      name: r[0], category: r[1], unit: r[2],
      stock, min, price: r[5],
      supplier: r[6], supplierId: sup ? sup.id : null,
      location: ['Dépôt central Tunis', 'Dépôt chantier PRJ-001', 'Dépôt Sfax'][i % 3],
      lastEntry: dt.add(TODAY, -(3 + (i % 28))),
      stockStatus: stock === 0 ? 'rupture' : (stock < min ? 'faible' : 'ok')
    };
  });

  /* Matériaux « à la une » : les deux premières références de chaque fournisseur */
  suppliers.forEach(s => {
    s.featured = articles.filter(a => a.supplierId === s.id).slice(0, 2).map(a => a.id);
  });

  /* =======================================================
     TÂCHES (30) — 5 en retard
     ======================================================= */
  const TASK_ROWS = [
    // [titre, projet, responsable, priorité, début, échéance, progression, statut]
    ['Coulage dalle niveau 3 — bloc B', 'PRJ-001', 'Mohamed Ali Ben Salah', 'haute', '2026-08-10', '2026-08-18', 45, 'en_cours'],
    ['Tirage des câbles bloc A', 'PRJ-001', 'Sami Ben Amor', 'haute', '2026-07-20', '2026-08-11', 78, 'en_cours'],
    ['Pose des sanitaires bloc A', 'PRJ-001', 'Nabil Gharbi', 'moyenne', '2026-08-05', '2026-08-28', 30, 'en_cours'],
    ['Enduit façade nord', 'PRJ-001', 'Hatem Zouari', 'basse', '2026-08-20', '2026-09-15', 0, 'a_faire'],
    ['Réception béton — attente livraison', 'PRJ-001', 'Amine Ben Cheikh', 'haute', '2026-08-12', '2026-08-13', 20, 'bloque'],
    ['Ferraillage poteaux niveau 4', 'PRJ-001', 'Wajdi Louati', 'moyenne', '2026-08-14', '2026-08-24', 0, 'a_faire'],
    ['Étanchéité toiture terrasse', 'PRJ-002', 'Anis Mabrouk', 'haute', '2026-07-28', '2026-08-19', 60, 'en_cours'],
    ['Pose carrelage rez-de-chaussée', 'PRJ-002', 'Youssef Sassi', 'moyenne', '2026-08-01', '2026-08-25', 55, 'en_cours'],
    ['Raccordement tableau électrique', 'PRJ-002', 'Sami Ben Amor', 'haute', '2026-08-03', '2026-08-18', 80, 'en_cours'],
    ['Livraison menuiserie alu — fournisseur en retard', 'PRJ-002', 'Khaled Trabelsi', 'haute', '2026-07-25', '2026-08-05', 0, 'bloque'],
    ['Aménagement piscine', 'PRJ-002', 'Riadh Hamrouni', 'basse', '2026-08-18', '2026-08-30', 0, 'a_faire'],
    ['Coffrage voile parking niveau -1', 'PRJ-003', 'Ghazi Toumi', 'haute', '2026-08-04', '2026-08-20', 62, 'en_cours'],
    ['Montage grue secteur est', 'PRJ-003', 'Elyes Hammami', 'moyenne', '2026-07-15', '2026-07-30', 100, 'termine'],
    ['Plan de calepinage galerie', 'PRJ-003', 'Bilel Haddad', 'moyenne', '2026-08-10', '2026-09-05', 25, 'en_cours'],
    ['Chemins de câbles zone commerciale', 'PRJ-003', 'Ridha Ben Youssef', 'moyenne', '2026-08-12', '2026-09-20', 15, 'en_cours'],
    ['Réseau évacuation eaux pluviales', 'PRJ-003', 'Slim Nasri', 'basse', '2026-09-01', '2026-10-10', 0, 'a_faire'],
    ['Reprise fissures façade sud', 'PRJ-004', 'Hichem Ben Abdallah', 'haute', '2026-07-10', '2026-08-01', 65, 'en_cours'],
    ['Pose faux plafonds étages 2-4', 'PRJ-004', 'Karim Ayadi', 'moyenne', '2026-08-08', '2026-09-12', 20, 'en_cours'],
    ['Contrôle conformité électrique', 'PRJ-004', 'Walid Khelifi', 'haute', '2026-08-15', '2026-08-29', 0, 'a_faire'],
    ['Étanchéité terrasse — attente budget', 'PRJ-004', 'Jaber Mathlouthi', 'haute', '2026-08-06', '2026-08-10', 10, 'bloque'],
    ['Colonne montante eau', 'PRJ-004', 'Mehdi Jaziri', 'moyenne', '2026-07-01', '2026-07-31', 100, 'termine'],
    ['Dépôt du permis de bâtir', 'PRJ-005', 'Sonia Belhaj', 'haute', '2026-07-01', '2026-08-20', 70, 'en_cours'],
    ['Étude géotechnique', 'PRJ-005', 'Nizar Hamdi', 'haute', '2026-06-15', '2026-07-25', 100, 'termine'],
    ['Consultation entreprises terrassement', 'PRJ-005', 'Aymen Dridi', 'moyenne', '2026-08-18', '2026-09-05', 0, 'a_faire'],
    ['Montage charpente travée 4-8', 'PRJ-006', 'Zied Ben Romdhane', 'haute', '2026-08-01', '2026-08-26', 58, 'en_cours'],
    ['Alimentation électrique quai', 'PRJ-006', 'Oussama Guesmi', 'moyenne', '2026-08-10', '2026-09-15', 30, 'en_cours'],
    ['Dalle quai de chargement', 'PRJ-006', 'Marwen Ferchichi', 'moyenne', '2026-06-20', '2026-07-28', 100, 'termine'],
    ['Peinture chambres étage 3', 'PRJ-007', 'Nader Bettaieb', 'moyenne', '2026-08-05', '2026-08-22', 48, 'en_cours'],
    ['Remplacement colonnes sanitaires', 'PRJ-007', 'Imed Kacem', 'haute', '2026-06-10', '2026-08-21', 92, 'en_cours'],
    ['Bornage et implantation lots 1-12', 'PRJ-008', 'Nizar Hamdi', 'moyenne', '2026-08-04', '2026-09-10', 35, 'en_cours']
  ];
  const tasks = TASK_ROWS.map((r, i) => ({
    id: 'TSK-' + String(i + 1).padStart(3, '0'),
    title: r[0], projectId: r[1], assignee: r[2], priority: r[3],
    start: r[4], due: r[5], progress: r[6], status: r[7],
    createdAt: dt.add(r[4], -6)
  }));

  /* =======================================================
     POINTAGES — générés par date, de façon déterministe
     Aujourd'hui : 42 prévus, 37 présents, 5 absents, 284 h
     ======================================================= */
  const RUNNING = ['PRJ-001', 'PRJ-002', 'PRJ-003', 'PRJ-004', 'PRJ-006', 'PRJ-007'];
  const scheduledWorkers = workers.filter(w => RUNNING.includes(w.projectId)); // 42

  const ABSENCE_REASONS = ['Congé annuel', 'Arrêt maladie', 'Absence non justifiée', 'Congé annuel', 'Accident domestique'];

  function buildTimesheets(date, targetHours) {
    const rnd = seeded(hash('ts' + date));
    const absentIdx = new Set();
    while (absentIdx.size < 5) absentIdx.add(Math.floor(rnd() * scheduledWorkers.length));

    const rows = scheduledWorkers.map((w, i) => {
      if (absentIdx.has(i)) {
        return {
          id: `PTG-${date}-${w.id}`, date, workerId: w.id, worker: w.name, trade: w.trade,
          projectId: w.projectId, in: null, out: null, breakMin: 0, hours: 0,
          status: 'absent', note: ABSENCE_REASONS[absentIdx.size % 5] || 'Absence non justifiée'
        };
      }
      const inMin = 7 * 60 + Math.round(rnd() * 30 - 10);               // 06:50 → 07:20
      const outMin = 15 * 60 + 50 + Math.round(rnd() * 30);             // 15:50 → 16:20
      const breakMin = 75 + Math.round(rnd() * 3) * 5;                  // 75 → 90 min (déjeuner)
      return {
        id: `PTG-${date}-${w.id}`, date, workerId: w.id, worker: w.name, trade: w.trade,
        projectId: w.projectId,
        in: inMin, out: outMin, breakMin,
        hours: (outMin - inMin - breakMin) / 60,
        status: inMin > 7 * 60 + 15 ? 'retard' : 'present',
        note: inMin > 7 * 60 + 15 ? 'Arrivée tardive' : ''
      };
    });

    // Calage sur le total attendu, réparti sur l'ensemble des présents
    if (targetHours) {
      const present = rows.filter(r => r.status !== 'absent');
      const sum = present.reduce((s, r) => s + r.hours, 0);
      const perWorker = Math.round((targetHours - sum) * 60 / present.length);
      present.forEach(r => {
        r.out += perWorker;
        r.hours = (r.out - r.in - r.breakMin) / 60;
      });
      const last = present[present.length - 1];
      const rest = targetHours - present.reduce((s, r) => s + r.hours, 0);
      last.out += Math.round(rest * 60);
      last.hours = (last.out - last.in - last.breakMin) / 60;
    }
    return rows;
  }

  const timesheetCache = {};
  function timesheets(date) {
    if (!timesheetCache[date]) {
      timesheetCache[date] = buildTimesheets(date, date === TODAY ? 284 : null);
    }
    return timesheetCache[date];
  }

  /* =======================================================
     DÉPENSES — 850 000 DT répartis par catégorie et par projet
     ======================================================= */
  const COST_CATEGORIES = [
    { key: 'main_oeuvre', label: 'Main-d\'œuvre', share: 0.35, color: '#14395C' },
    { key: 'materiaux', label: 'Matériaux', share: 0.30, color: '#E4651A' },
    { key: 'sous_traitance', label: 'Sous-traitance', share: 0.15, color: '#1C6FA8' },
    { key: 'equipement', label: 'Équipement', share: 0.09, color: '#17845A' },
    { key: 'transport', label: 'Transport', share: 0.07, color: '#B26A05' },
    { key: 'autres', label: 'Autres', share: 0.04, color: '#8698A9' }
  ];

  const expenses = [];
  projects.filter(p => p.status !== 'termine').forEach((p) => {
    const rnd = seeded(hash(p.id));
    // Répartition par catégorie, pondérée puis normalisée sur le consommé du projet
    const weights = COST_CATEGORIES.map(c => c.share * (0.8 + rnd() * 0.4));
    const total = weights.reduce((a, b) => a + b, 0);
    COST_CATEGORIES.forEach((c, i) => {
      expenses.push({
        id: `DEP-${p.id}-${c.key}`, projectId: p.id, category: c.key,
        label: c.label, amount: Math.round(p.spent * weights[i] / total)
      });
    });
  });

  /* =======================================================
     NOTIFICATIONS
     ======================================================= */
  const notifications = [
    { id: 'N1', level: 'danger', title: 'Résidence Les Jardins en retard de 3 jours', text: 'Lot électricité — échéance dépassée le 11/08', time: 'Il y a 25 min', link: '#/projets/PRJ-001', read: false },
    { id: 'N2', level: 'danger', title: 'Budget Villa Ben Ali au-delà de 80 %', text: '119 000 DT consommés sur 145 000 DT', time: 'Il y a 1 h', link: '#/budgets', read: false },
    { id: 'N3', level: 'warn', title: 'Stock de ciment sous le seuil minimum', text: 'Ciment blanc 25 kg — 46 sacs restants (seuil 60)', time: 'Il y a 2 h', link: '#/articles', read: false },
    { id: 'N4', level: 'warn', title: '5 ouvriers absents aujourd\'hui', text: 'Pointage du 14/08 — 37 présents sur 42 prévus', time: 'Il y a 3 h', link: '#/pointage', read: false },
    { id: 'N5', level: 'info', title: 'Béton prêt B25 en rupture', text: 'Commande à passer auprès de BétonPlus Tunisie', time: 'Hier, 17:20', link: '#/articles', read: true },
    { id: 'N6', level: 'info', title: 'Devis DEV-2026-118 accepté', text: 'Groupe Medina Invest — Lotissement Erriadh', time: 'Hier, 11:05', link: '#/clients/CLI-008', read: true }
  ];

  /* =======================================================
     JOURNAL D'ACTIVITÉ (fil du dashboard)
     ======================================================= */
  const activity = [
    { icon: 'check', tone: 'ok', title: 'Tâche terminée — Montage grue secteur est', meta: 'Elyes Hammami · Carthage Plaza', time: '08:12' },
    { icon: 'package', tone: 'info', title: 'Livraison réceptionnée — 200 sacs de ciment', meta: 'Ciments de Bizerte · Les Jardins', time: '07:45' },
    { icon: 'hardhat', tone: 'neutral', title: 'Pointage du matin validé', meta: '37 présents sur 42 prévus', time: '07:30' },
    { icon: 'alert', tone: 'danger', title: 'Blocage signalé — attente livraison béton', meta: 'Amine Ben Cheikh · Les Jardins', time: 'Hier 16:50' },
    { icon: 'wallet', tone: 'warn', title: 'Facture fournisseur enregistrée — 18 400 DT', meta: 'Sidérurgie El Fouladh', time: 'Hier 15:20' },
    { icon: 'users', tone: 'info', title: 'Nouveau client ajouté — Yasmine Retail Park', meta: 'Salma Bouzid · Hammamet', time: 'Hier 10:05' }
  ];

  /* =======================================================
     HISTORIQUE COMMERCIAL (fiche client)
     ======================================================= */
  function clientHistory(clientId) {
    const rnd = seeded(hash(clientId));
    const kinds = [
      { type: 'Devis', ref: 'DEV', tone: 'info' },
      { type: 'Commande', ref: 'CMD', tone: 'neutral' },
      { type: 'Facture', ref: 'FAC', tone: 'warn' },
      { type: 'Paiement', ref: 'PAY', tone: 'ok' },
      { type: 'Échange', ref: 'COM', tone: 'neutral' }
    ];
    return Array.from({ length: 6 }, (_, i) => {
      const k = kinds[Math.floor(rnd() * kinds.length)];
      return {
        type: k.type, tone: k.tone,
        ref: `${k.ref}-2026-${String(100 + Math.floor(rnd() * 90))}`,
        date: dt.add(TODAY, -Math.floor(rnd() * 240) - i * 5),
        amount: k.type === 'Échange' ? null : Math.round((5 + rnd() * 60)) * 1000,
        note: k.type === 'Échange' ? ['Appel téléphonique — avancement chantier', 'Réunion de chantier hebdomadaire', 'Visite du client sur site'][Math.floor(rnd() * 3)] : ''
      };
    }).sort((a, b) => b.date.localeCompare(a.date));
  }

  /* =========================================================
     MATÉRIAUX AFFECTÉS AUX CHANTIERS
     Sorties de stock déjà réalisées : les quantités en stock
     des articles en tiennent compte.
     ========================================================= */
  const projectMaterials = [];
  projects.filter(p => p.status !== 'termine').forEach((p, pi) => {
    const rnd = seeded(hash(p.id + '-mat'));
    const count = 3 + Math.floor(rnd() * 3);              // 3 à 5 matériaux par chantier
    const used = new Set();
    for (let i = 0; i < count; i++) {
      let a;
      do { a = articles[Math.floor(rnd() * articles.length)]; } while (used.has(a.id));
      used.add(a.id);
      const base = a.unit === 'unité' || a.unit === 'sac' ? 40 : a.unit === 'm³' ? 15 : 25;
      projectMaterials.push({
        id: `AFF-${p.id}-${String(i + 1).padStart(2, '0')}`,
        projectId: p.id, articleId: a.id,
        qty: Math.max(1, Math.round(base * (0.4 + rnd() * 1.6))),
        date: dt.add(TODAY, -(2 + Math.floor(rnd() * 40))),
        note: ['Sortie dépôt central', 'Livraison directe fournisseur', 'Réappro chantier', ''][Math.floor(rnd() * 4)],
        author: p.manager
      });
    }
  });

  /* =========================================================
     CATALOGUE DE TÂCHES — référentiel paramétrable
     Sert de liste déroulante à la création d'un projet.
     ========================================================= */
  const taskCatalog = [
    ['Installation de chantier', 'Préparation', 10, 'Chef d\'équipe'],
    ['Implantation et piquetage', 'Préparation', 5, 'Géomètre'],
    ['Démolition et curage', 'Préparation', 12, 'Conducteur d\'engin'],
    ['Terrassement général', 'Terrassement', 20, 'Conducteur d\'engin'],
    ['Fouilles en rigole', 'Terrassement', 10, 'Conducteur d\'engin'],
    ['Fondations et semelles', 'Gros œuvre', 25, 'Maçon'],
    ['Longrines et dallage', 'Gros œuvre', 18, 'Maçon'],
    ['Ferraillage poteaux et poutres', 'Gros œuvre', 22, 'Ferrailleur'],
    ['Coffrage et coulage des dalles', 'Gros œuvre', 30, 'Coffreur'],
    ['Maçonnerie et cloisons', 'Gros œuvre', 28, 'Maçon'],
    ['Charpente et couverture', 'Gros œuvre', 20, 'Charpentier'],
    ['Étanchéité toiture-terrasse', 'Second œuvre', 12, 'Étancheur'],
    ['Réseaux électriques', 'Second œuvre', 25, 'Électricien'],
    ['Réseaux de plomberie', 'Second œuvre', 22, 'Plombier'],
    ['Climatisation et ventilation', 'Second œuvre', 18, 'Technicien CVC'],
    ['Menuiserie aluminium', 'Second œuvre', 20, 'Menuisier'],
    ['Menuiserie bois', 'Second œuvre', 15, 'Menuisier'],
    ['Enduits et plâtrerie', 'Finitions', 20, 'Plâtrier'],
    ['Carrelage et faïence', 'Finitions', 25, 'Carreleur'],
    ['Peinture intérieure', 'Finitions', 18, 'Peintre'],
    ['Peinture et enduit de façade', 'Finitions', 15, 'Peintre'],
    ['Aménagements extérieurs', 'Finitions', 15, 'Maçon'],
    ['Nettoyage de fin de chantier', 'Réception', 5, 'Chef d\'équipe'],
    ['Essais et mise en service', 'Réception', 7, 'Technicien CVC'],
    ['Levée des réserves', 'Réception', 10, 'Chef d\'équipe'],
    ['Réception définitive des travaux', 'Réception', 3, 'Chef de projet']
  ].map(([name, category, days, trade], i) => ({
    id: 'CAT-' + String(i + 1).padStart(3, '0'),
    name, category, defaultDays: days, trade,
    active: true
  }));

  const TASK_PHASES = ['Préparation', 'Terrassement', 'Gros œuvre', 'Second œuvre', 'Finitions', 'Réception'];

  /* =========================================================
     ATTACHEMENTS — pièces jointes par chantier
     ========================================================= */
  const attachments = {
    'PRJ-001': [
      { id: 'ATT-001', name: 'Plan de masse — niveau R+2.pdf', kind: 'plan', size: 2411000, date: dt.add(TODAY, -34), author: 'Ahmed Ben Ali' },
      { id: 'ATT-002', name: 'Photo coffrage dalle bloc B.jpg', kind: 'photo', size: 1840000, date: dt.add(TODAY, -3), author: 'Mohamed Ali Ben Salah' },
      { id: 'ATT-003', name: 'PV réunion de chantier n°12.pdf', kind: 'document', size: 318000, date: dt.add(TODAY, -6), author: 'Ahmed Ben Ali' }
    ],
    'PRJ-002': [
      { id: 'ATT-004', name: 'Constat fissures façade sud.jpg', kind: 'photo', size: 2110000, date: dt.add(TODAY, -9), author: 'Anis Mabrouk' },
      { id: 'ATT-005', name: 'Devis étanchéité — sous-traitant.pdf', kind: 'document', size: 154000, date: dt.add(TODAY, -15), author: 'Ahmed Ben Ali' }
    ],
    'PRJ-003': [
      { id: 'ATT-006', name: 'Plan de coffrage sous-sol.pdf', kind: 'plan', size: 3620000, date: dt.add(TODAY, -21), author: 'Ahmed Ben Ali' }
    ]
  };

  /* Devis créés depuis les fiches clients (vides au démarrage) */
  const quotes = [];

  /* ---------- Export ---------- */
  ERP.dt = dt;
  ERP.seeded = seeded;
  ERP.hash = hash;
  ERP.DB = {
    today: TODAY, user, clients, projects, workers, articles, tasks,
    expenses, notifications, activity, costCategories: COST_CATEGORIES,
    taskCatalog, taskPhases: TASK_PHASES, attachments, quotes, projectMaterials, suppliers,
    scheduledToday: scheduledWorkers.length,
    timesheets, clientHistory
  };

  /* =========================================================
     PERSISTANCE LOCALSTORAGE
     Les modifications (tâches, pointages, articles, projets…)
     sont enregistrées pour survivre aux rechargements.
     Idéal pour démos et tests. Réinitialiser via Paramètres.
     ========================================================= */
  const STORAGE_KEY = 'batipilot-db-v1';

  const PERSIST_KEYS = [
    'user', 'clients', 'projects', 'workers', 'articles', 'tasks',
    'expenses', 'notifications', 'activity', 'taskCatalog',
    'attachments', 'quotes', 'projectMaterials', 'suppliers'
  ];

  function serializeDB() {
    const snapshot = {};
    PERSIST_KEYS.forEach(k => {
      if (ERP.DB[k] !== undefined) snapshot[k] = ERP.DB[k];
    });
    // Cache des pointages (objets mutables générés à la volée)
    snapshot._timesheetCache = {};
    Object.keys(timesheetCache).forEach(date => {
      snapshot._timesheetCache[date] = timesheetCache[date];
    });
    snapshot.today = ERP.DB.today;
    return snapshot;
  }

  function saveDB() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeDB()));
    } catch (e) {
      console.warn('[BâtiPilot] Impossible d\'enregistrer les données', e);
    }
  }

  function loadDB() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const snapshot = JSON.parse(raw);
      if (!snapshot || typeof snapshot !== 'object') return false;

      PERSIST_KEYS.forEach(k => {
        if (snapshot[k] !== undefined) ERP.DB[k] = snapshot[k];
      });
      if (snapshot.today) ERP.DB.today = snapshot.today;

      // Restaurer le cache des pointages
      if (snapshot._timesheetCache) {
        Object.keys(timesheetCache).forEach(k => delete timesheetCache[k]);
        Object.assign(timesheetCache, snapshot._timesheetCache);
      }

      // Recalculer le nombre d'ouvriers planifiés aujourd'hui
      const RUNNING = ['PRJ-001', 'PRJ-002', 'PRJ-003', 'PRJ-004', 'PRJ-006', 'PRJ-007'];
      ERP.DB.scheduledToday = (ERP.DB.workers || []).filter(w => RUNNING.includes(w.projectId)).length;

      console.info('%cBâtiPilot', 'font:600 14px Barlow Semi Condensed;color:#E4651A',
        '— données restaurées depuis localStorage');
      return true;
    } catch (e) {
      console.warn('[BâtiPilot] Impossible de restaurer les données', e);
      return false;
    }
  }

  function clearDB() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // Exposer pour l'API et les paramètres
  ERP.DB.save = saveDB;
  ERP.DB.load = loadDB;
  ERP.DB.clear = clearDB;
  ERP.DB._storageKey = STORAGE_KEY;

  // Restauration automatique au démarrage
  loadDB();
})(window.ERP);
