const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== MIDDLEWARES =====
app.use(helmet());
app.use(cors({
  origin: '*',
  methods: ['GET'],
  credentials: false
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // máximo 100 requests per window per IP
  message: {
    error: 'Demasiadas solicitudes desde esta IP. Inténtalo más tarde.'
  }
});
app.use(limiter);

// ===== CONFIGURACIÓN GOOGLE SHEETS =====
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const SHEET_ID = '1xJ65-Z8cpoWzgBW3wcXTinKTAvh-L4zUmesouoAaVRA';
const SHEET_NAME = 'Productos participantes';

// Configurar autenticación con Service Account
async function getGoogleSheetsClient() {
  try {
    const auth = new google.auth.GoogleAuth({ 
      credentials: {
        type: process.env.GOOGLE_TYPE,
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // ← Esto es CRÍTICO
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        auth_uri: process.env.GOOGLE_AUTH_URI,
        token_uri: process.env.GOOGLE_TOKEN_URI,
        auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
        client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
        universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN
      },
      scopes: SCOPES,
    });

    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    console.error('Error configurando Google Sheets client:', error);
    throw error;
  }
}

// ===== FUNCIONES AUXILIARES =====
function procesarProductos(rawData) {
  if (!rawData || rawData.length <= 1) {
    return [];
  }

  // Omitir headers (primera fila)
  const rows = rawData.slice(1);
  
  return rows.map(row => {
    const [nombreProducto, vigencia, compraMinima, imagen] = row;
    
    // Saltar filas vacías
    if (!nombreProducto || nombreProducto.toString().trim() === '') {
      return null;
    }
    
    // Extraer fechas de vigencia
    let fechaInicio = '';
    let fechaFin = '';
    
    if (vigencia) {
      const vigenciaStr = vigencia.toString();
      const fechaMatch = vigenciaStr.match(/del\s+(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})/i);
      if (fechaMatch) {
        fechaInicio = fechaMatch[1];
        fechaFin = fechaMatch[2];
      }
    }
    
    return {
      nombre: nombreProducto.toString().trim(),
      vigenciaCompleta: vigencia ? vigencia.toString() : '',
      fechaInicio: fechaInicio,
      fechaFin: fechaFin,
      compraMinima: compraMinima ? compraMinima.toString() : '',
      imagen: imagen ? imagen.toString().trim() : '',
      // Metadatos adicionales
      id: generateProductId(nombreProducto.toString()),
      fechaActualizacion: new Date().toISOString()
    };
  }).filter(producto => producto !== null);
}

function generateProductId(nombre) {
  return nombre.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);
}

function validateProducto(producto) {
  const errors = [];
  
  if (!producto.nombre) errors.push('Nombre requerido');
  if (!producto.imagen) errors.push('Imagen requerida');
  if (!producto.compraMinima) errors.push('Compra mínima requerida');
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

// ===== RUTAS =====

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// Ruta principal para obtener productos
app.get('/api/productos', async (req, res) => {
  try {
    console.log('📝 Solicitando productos desde Google Sheets...');
    
    const sheets = await getGoogleSheetsClient();
    
    // Obtener datos del sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:D`, // Columnas A-D (nombre, vigencia, compra minima, imagen)
    });
    
    const rawData = response.data.values;
    console.log(`📊 Datos obtenidos: ${rawData ? rawData.length : 0} filas`);
    
    if (!rawData) {
      return res.status(404).json({
        success: false,
        error: 'No se encontraron datos en el sheet',
        productos: [],
        total: 0
      });
    }
    
    // Procesar productos
    const productos = procesarProductos(rawData);
    console.log(`✅ Productos procesados: ${productos.length}`);
    
    // Validar productos (opcional - loggar warnings)
    const productosInvalidos = productos.filter(p => !validateProducto(p).isValid);
    if (productosInvalidos.length > 0) {
      console.warn(`⚠️ ${productosInvalidos.length} productos con datos incompletos`);
    }
    
    // Respuesta exitosa
    res.json({
      success: true,
      productos: productos,
      total: productos.length,
      metadata: {
        timestamp: new Date().toISOString(),
        sheetId: SHEET_ID,
        sheetName: SHEET_NAME,
        productosValidos: productos.filter(p => validateProducto(p).isValid).length,
        productosInvalidos: productosInvalidos.length
      }
    });
    
  } catch (error) {
    console.error('❌ Error obteniendo productos:', error);
    
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
      productos: [],
      total: 0
    });
  }
});

// Ruta para obtener un producto específico por ID
app.get('/api/productos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const sheets = await getGoogleSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:D`,
    });
    
    const productos = procesarProductos(response.data.values);
    const producto = productos.find(p => p.id === id);
    
    if (!producto) {
      return res.status(404).json({
        success: false,
        error: 'Producto no encontrado'
      });
    }
    
    res.json({
      success: true,
      producto: producto
    });
    
  } catch (error) {
    console.error('Error obteniendo producto:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// Ruta para estadísticas
app.get('/api/stats', async (req, res) => {
  try {
    const sheets = await getGoogleSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:D`,
    });
    
    const productos = procesarProductos(response.data.values);
    
    res.json({
      success: true,
      stats: {
        totalProductos: productos.length,
        productosActivos: productos.length, // Todos están activos por defecto
        ultimaActualizacion: new Date().toISOString(),
        categorias: {
          // Puedes agregar lógica para categorizar productos
          conImagen: productos.filter(p => p.imagen).length,
          sinImagen: productos.filter(p => !p.imagen).length,
          conVigencia: productos.filter(p => p.vigenciaCompleta).length
        }
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// Middleware para rutas no encontradas
// app.use('/*', (req, res) => {
//   res.status(404).json({
//     success: false,
//     error: 'Ruta no encontrada',
//     availableEndpoints: [
//       'GET /health',
//       'POST /api/productos',
//       'GET /api/productos/:id',
//       'GET /api/stats'
//     ]
//   });
// });

// Middleware para manejo de errores globales
app.use((error, req, res, next) => {
  console.error('Error no manejado:', error);
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor'
  });
});

// ===== INICIAR SERVIDOR =====
app.listen(PORT, () => {
  console.log(`🚀 Servidor Super Rifas ejecutándose en puerto ${PORT}`);
  console.log(`📊 Google Sheets ID: ${SHEET_ID}`);
  console.log(`📋 Hoja: ${SHEET_NAME}`);
  console.log(`🌍 Modo: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Recibida señal SIGTERM, cerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Recibida señal SIGINT, cerrando servidor...');
  process.exit(0);
});