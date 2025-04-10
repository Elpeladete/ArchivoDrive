/**
 * Configuración global
 */
const FOLDER_ID = '1XpJ0FZrOQ6-72BFnfyoOfkfa3MIX_urd'; // ID de la carpeta de destino
const CHUNK_SIZE = 15 * 1024 * 1024; // 15MB por fragmento (aumentado para mayor velocidad)
const MAX_EXECUTION_TIME = 300000; // 5 minutos en milisegundos (para dejar margen de seguridad)

/**
 * Crea la interfaz de usuario HTML
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Subir Archivos a Google Drive')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Sube un archivo completo directamente
 * @param {Object} data - Datos del archivo
 * @return {Object} - Estado de la subida
 */
function uploadFile(data) {
  try {
    const { bytes, fileName, contentType } = data;
    
    // Decodificar los bytes
    const blobBytes = Utilities.base64Decode(bytes);
    const blob = Utilities.newBlob(blobBytes, contentType, fileName);
    
    // Crear el archivo en Drive
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const file = folder.createFile(blob);
    
    return {
      status: 'success',
      fileId: file.getId(),
      fileName: fileName,
      fileUrl: file.getUrl(),
      message: 'Archivo subido completamente',
      percentComplete: 100
    };
  } catch (error) {
    Logger.log('Error en uploadFile: ' + error.toString());
    return {
      status: 'error',
      message: 'Error: ' + error.toString()
    };
  }
}

/**
 * Verifica si el usuario tiene acceso a la carpeta de destino
 * @return {Object} - Estado del acceso
 */
function checkFolderAccess() {
  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    return {
      status: 'success',
      folderName: folder.getName(),
      folderUrl: folder.getUrl()
    };
  } catch (error) {
    Logger.log('Error en checkFolderAccess: ' + error.toString());
    return {
      status: 'error',
      message: 'No tienes acceso a la carpeta de destino: ' + error.toString()
    };
  }
}

/**
 * Obtiene la lista de archivos en la carpeta de destino
 * @return {Object} - Lista de archivos
 */
function getFilesList() {
  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const files = folder.getFiles();
    const filesList = [];
    
    while (files.hasNext()) {
      const file = files.next();
      filesList.push({
        id: file.getId(),
        name: file.getName(),
        size: file.getSize(),
        date: file.getDateCreated(),
        url: file.getUrl(),
        mimeType: file.getMimeType()
      });
    }
    
    return {
      status: 'success',
      files: filesList
    };
  } catch (error) {
    Logger.log('Error en getFilesList: ' + error.toString());
    return {
      status: 'error',
      message: 'Error al obtener la lista de archivos: ' + error.toString()
    };
  }
}

/**
 * Inicia o reanuda una subida en fragmentos
 * @param {Object} data - Metadatos del archivo
 * @return {Object} - ID de la sesión de subida
 */
function initOrResumeChunkedUpload(data) {
  try {
    const { fileName, contentType, fileSize, resumeUploadId } = data;
    const userProps = PropertiesService.getUserProperties();
    
    // Si estamos reanudando una subida existente
    if (resumeUploadId) {
      // Verificar si existe la subida
      const uploadData = userProps.getProperty(resumeUploadId);
      if (!uploadData) {
        return {
          status: 'error',
          message: 'La sesión de subida no existe o ha expirado'
        };
      }
      
      // Obtener los datos de la subida
      const uploadInfo = JSON.parse(uploadData);
      
      // Verificar si todos los fragmentos ya están subidos
      const allChunksUploaded = uploadInfo.nextChunk >= uploadInfo.totalChunks;
      
      // Si es necesario combinar fragmentos (todos subidos pero no combinados)
      if (allChunksUploaded && uploadInfo.isCombiningChunks) {
        return {
          status: 'resume',
          uploadId: resumeUploadId,
          nextChunk: uploadInfo.totalChunks, // Indicar que todos los fragmentos están listos
          fileName: uploadInfo.fileName,
          totalChunks: uploadInfo.totalChunks,
          needsFinalization: true,
          message: `Todos los fragmentos de "${uploadInfo.fileName}" han sido subidos. Es necesario finalizar la combinación.`
        };
      }
      
      return {
        status: 'resume',
        uploadId: resumeUploadId,
        nextChunk: uploadInfo.nextChunk,
        fileName: uploadInfo.fileName,
        totalChunks: uploadInfo.totalChunks,
        message: `Reanudando subida desde el fragmento ${uploadInfo.nextChunk + 1} de ${uploadInfo.totalChunks}`
      };
    }
    
    // Crear una nueva sesión de subida
    const uploadId = Utilities.getUuid();
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    
    // Guardar los metadatos de la subida
    const uploadInfo = {
      fileName: fileName,
      contentType: contentType,
      fileSize: fileSize,  // Asegurarse de guardar el tamaño total
      totalChunks: totalChunks,
      nextChunk: 0,
      uploadedChunks: [],
      startTime: new Date().getTime(),
      tempFileId: null,
      finalFileId: null
    };
    
    // Crear un archivo temporal vacío para el resultado final
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const emptyBlob = Utilities.newBlob('', contentType, fileName + ' (subiendo...)');
    const tempFile = folder.createFile(emptyBlob);
    uploadInfo.tempFileId = tempFile.getId();
    
    // Guardar la información de la subida
    userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
    
    return {
      status: 'success',
      uploadId: uploadId,
      fileName: fileName,
      totalChunks: totalChunks,
      nextChunk: 0,
      message: 'Subida inicializada'
    };
  } catch (error) {
    Logger.log('Error en initOrResumeChunkedUpload: ' + error.toString());
    return {
      status: 'error',
      message: 'Error al inicializar la subida: ' + error.toString()
    };
  }
}

/**
 * Sube un fragmento de archivo y verifica si necesitamos combinar fragmentos
 * @param {Object} data - Datos del fragmento
 * @return {Object} - Estado de la subida
 */
function uploadChunk(data) {
  try {
    const startTime = new Date().getTime();
    const { bytes, uploadId, chunkIndex, totalChunks, isResumingManually, isAutoResume } = data;
    const userProps = PropertiesService.getUserProperties();
    
    // Obtener la información de la subida
    const uploadDataStr = userProps.getProperty(uploadId);
    if (!uploadDataStr) {
      return {
        status: 'error',
        message: 'La sesión de subida no existe o ha expirado'
      };
    }
    
    const uploadInfo = JSON.parse(uploadDataStr);
    
    // Si estamos reanudando manualmente o automáticamente, resetear el contador y el tiempo
    if (isResumingManually || isAutoResume) {
      uploadInfo.autoResumeAttempts = 0;
      uploadInfo.startTime = new Date().getTime(); // Reiniciar el tiempo para dar margen al nuevo intento
      uploadInfo.lastTimeoutTime = null;
    }
    
    // Inicializar contador de intentos si no existe
    if (uploadInfo.autoResumeAttempts === undefined) {
      uploadInfo.autoResumeAttempts = 0;
    }
    
    // Verificar que el fragmento sea el esperado o uno ya procesado
    if (chunkIndex < uploadInfo.nextChunk) {
      // Este fragmento ya fue procesado, devolver éxito sin reprocesar
      return {
        status: 'chunk-uploaded',
        uploadId: uploadId,
        nextChunk: uploadInfo.nextChunk,
        fileName: uploadInfo.fileName,
        totalChunks: totalChunks,
        percentComplete: Math.round((uploadInfo.nextChunk / totalChunks) * 100),
        autoResumeAttempts: uploadInfo.autoResumeAttempts,
        message: `Fragmento ${chunkIndex + 1} ya fue procesado. Continuando desde ${uploadInfo.nextChunk + 1}`
      };
    } else if (chunkIndex > uploadInfo.nextChunk) {
      // Fragmento incorrecto, indicar cuál es el esperado
      return {
        status: 'error',
        message: `Fragmento incorrecto. Se esperaba ${uploadInfo.nextChunk}, se recibió ${chunkIndex}`,
        expectedChunk: uploadInfo.nextChunk
      };
    }
    
    // Decodificar los bytes del fragmento
    const blobBytes = Utilities.base64Decode(bytes);
    const chunkBlob = Utilities.newBlob(blobBytes);
    
    try {
      // Guardar este fragmento como un archivo temporal individual
      const folder = DriveApp.getFolderById(FOLDER_ID);
      const chunkFileName = `${uploadInfo.fileName}.part${chunkIndex}`;
      const chunkFile = folder.createFile(chunkBlob.setName(chunkFileName));
      
      // Guardar la referencia al fragmento
      if (!uploadInfo.chunkFiles) {
        uploadInfo.chunkFiles = [];
      }
      
      // Asegurarse de que el array tiene el tamaño adecuado
      while (uploadInfo.chunkFiles.length <= chunkIndex) {
        uploadInfo.chunkFiles.push(null);
      }
      
      // Guardar el ID del fragmento
      uploadInfo.chunkFiles[chunkIndex] = chunkFile.getId();
      
      // Actualizar la información de la subida
      uploadInfo.nextChunk = chunkIndex + 1;
      uploadInfo.uploadedChunks.push(chunkIndex);
      uploadInfo.lastUpdateTime = new Date().getTime();
      
      // Guardar información actualizada
      userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
      
      // Calcular el progreso
      const percentComplete = Math.round(((chunkIndex + 1) / totalChunks) * 100);
      
      // Verificar si hemos completado la subida
      if (chunkIndex === totalChunks - 1) {
        // Todos los fragmentos han sido subidos, combinarlos
        // Resetear el contador de intentos antes de combinar
        uploadInfo.autoResumeAttempts = 0;
        userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
        
        return combineChunks(uploadId);
      }
      
      // Verificar si estamos cerca del límite de tiempo de ejecución
      const currentTime = new Date().getTime();
      const elapsedTime = currentTime - startTime;
      const totalElapsedTime = currentTime - uploadInfo.startTime;
      
      if (totalElapsedTime > MAX_EXECUTION_TIME) {
        // Guardar el tiempo del timeout para evitar entrar en bucles demasiado rápidos
        uploadInfo.lastTimeoutTime = currentTime;
        // Incrementar el contador de intentos automáticos pero no más de un límite
        uploadInfo.autoResumeAttempts = Math.min(uploadInfo.autoResumeAttempts + 1, 10);
        userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
        
        return {
          status: 'auto-resume',  // Nuevo estado para indicar reanudación automática
          uploadId: uploadId,
          nextChunk: uploadInfo.nextChunk,
          fileName: uploadInfo.fileName,
          totalChunks: totalChunks,
          percentComplete: percentComplete,
          autoResumeAttempts: uploadInfo.autoResumeAttempts,
          message: 'Límite de tiempo alcanzado, reanudando automáticamente...'
        };
      }
      
      return {
        status: 'chunk-uploaded',
        uploadId: uploadId,
        nextChunk: uploadInfo.nextChunk,
        fileName: uploadInfo.fileName,
        totalChunks: totalChunks,
        percentComplete: percentComplete,
        autoResumeAttempts: uploadInfo.autoResumeAttempts,
        message: `Fragmento ${chunkIndex + 1} de ${totalChunks} subido correctamente`
      };
    } catch (e) {
      Logger.log('Error al procesar fragmento: ' + e.toString());
      return {
        status: 'error',
        message: 'Error al procesar fragmento: ' + e.toString()
      };
    }
    
  } catch (error) {
    Logger.log('Error en uploadChunk: ' + error.toString());
    return {
      status: 'error',
      message: 'Error al subir fragmento: ' + error.toString()
    };
  }
}

/**
 * Combina todos los fragmentos en un archivo final
 * @param {string} uploadId - ID de la sesión de subida
 * @param {boolean} isFinalAttempt - Indica si es el último intento forzado
 * @param {boolean} isAutoRetry - Indica si es un reintento automático
 * @return {Object} - Estado de la combinación
 */
function combineChunks(uploadId, isFinalAttempt, isAutoRetry) {
  try {
    const startExecutionTime = new Date().getTime();
    const SAFETY_MARGIN = 30000; // 30 segundos de margen de seguridad
    const EFFECTIVE_MAX_TIME = MAX_EXECUTION_TIME - SAFETY_MARGIN;
    
    Logger.log(`[INFO] Iniciando combineChunks para uploadId: ${uploadId}, isFinalAttempt: ${isFinalAttempt}, isAutoRetry: ${isAutoRetry}`);
    const userProps = PropertiesService.getUserProperties();
    
    // Obtener la información de la subida
    const uploadDataStr = userProps.getProperty(uploadId);
    if (!uploadDataStr) {
      Logger.log('[ERROR] Sesión de subida no encontrada o expirada');
      return {
        status: 'error',
        message: 'La sesión de subida no existe o ha expirado'
      };
    }
    
    const uploadInfo = JSON.parse(uploadDataStr);
    Logger.log(`[INFO] Subida encontrada: ${uploadInfo.fileName}, ${uploadInfo.totalChunks} fragmentos`);
    
    // Verificar que tengamos todos los fragmentos
    if (!uploadInfo.chunkFiles || uploadInfo.chunkFiles.length !== uploadInfo.totalChunks) {
      Logger.log(`[ERROR] Faltan fragmentos: ${uploadInfo.chunkFiles ? uploadInfo.chunkFiles.length : 0}/${uploadInfo.totalChunks}`);
      return {
        status: 'error',
        message: 'Faltan fragmentos para completar la subida'
      };
    }
    
    // Para evitar problemas con el timeout, marcar que estamos intentando combinar
    if (!isFinalAttempt) {
      uploadInfo.isCombiningChunks = true;
    }
    
    // Resetear tiempo de inicio si es un reintento automático
    if (isAutoRetry) {
      uploadInfo.startTime = new Date().getTime();
      uploadInfo.combineAttempts = (uploadInfo.combineAttempts || 0) + 1;
    } else if (!uploadInfo.combineAttempts) {
      uploadInfo.combineAttempts = 0;
    }
    
    // Guardar estado actualizado
    userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
    
    // Determinar desde qué fragmento debemos comenzar (si es una continuación)
    const startFromChunk = uploadInfo.lastProcessedChunk !== undefined ? uploadInfo.lastProcessedChunk + 1 : 0;
    const sessionUrl = uploadInfo.sessionUrl;
    let totalBytesSent = uploadInfo.bytesSent || 0;
    
    Logger.log(`[INFO] Comenzando desde fragmento ${startFromChunk}, bytes enviados: ${totalBytesSent}`);
    
    // Si no hay una sesión de carga resumible existente o estamos comenzando desde cero
    let newSessionUrl = sessionUrl;
    if (!newSessionUrl || startFromChunk === 0) {
      // Iniciar una nueva sesión de carga resumible
      Logger.log('[INFO] Iniciando nueva sesión de carga resumible');
      
      const fileMetadata = {
        name: uploadInfo.fileName,
        mimeType: uploadInfo.contentType,
        parents: [FOLDER_ID]
      };
      
      try {
        const initiateResponse = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
            'Content-Type': 'application/json; charset=UTF-8'
          },
          payload: JSON.stringify(fileMetadata),
          muteHttpExceptions: true
        });
        
        if (initiateResponse.getResponseCode() !== 200) {
          throw new Error('Error al iniciar sesión: ' + initiateResponse.getContentText());
        }
        
        newSessionUrl = initiateResponse.getHeaders()['Location'];
        if (!newSessionUrl) {
          throw new Error('No se recibió URL de sesión');
        }
        
        // Guardar la URL de sesión para futuras continuaciones
        uploadInfo.sessionUrl = newSessionUrl;
        userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
        
        Logger.log('[INFO] Nueva URL de sesión obtenida correctamente');
      } catch (error) {
        Logger.log(`[ERROR] Error al iniciar sesión: ${error.toString()}`);
        return {
          status: 'error',
          message: 'Error al iniciar la sesión de carga: ' + error.toString()
        };
      }
    }
    
    // Procesar fragmentos hasta que nos acerquemos al límite de tiempo
    const totalSize = uploadInfo.fileSize;
    for (let i = startFromChunk; i < uploadInfo.totalChunks; i++) {
      // Verificar si estamos cerca del límite de tiempo
      const currentTime = new Date().getTime();
      const elapsedTime = currentTime - startExecutionTime;
      
      // Si estamos cerca del límite y no es el último fragmento, preparar para continuar en la próxima ejecución
      if (elapsedTime > EFFECTIVE_MAX_TIME && i < uploadInfo.totalChunks - 1) {
        Logger.log(`[WARN] Acercándose al límite de tiempo (${elapsedTime}ms). Pausando en fragmento ${i}`);
        
        // Actualizar el progreso para la próxima ejecución
        uploadInfo.lastProcessedChunk = i - 1; // El último fragmento procesado completamente
        uploadInfo.bytesSent = totalBytesSent;
        uploadInfo.sessionUrl = newSessionUrl;
        userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
        
        return {
          status: 'combine-continue',
          uploadId: uploadId,
          nextChunk: uploadInfo.totalChunks,
          fileName: uploadInfo.fileName,
          totalChunks: uploadInfo.totalChunks,
          percentComplete: Math.round(((i) / uploadInfo.totalChunks) * 100),
          lastProcessedChunk: i - 1,
          message: `Combinando fragmentos. Procesados ${i} de ${uploadInfo.totalChunks}.`
        };
      }
      
      if (!uploadInfo.chunkFiles[i]) {
        Logger.log(`[WARN] Fragmento ${i} no encontrado, saltando`);
        continue;
      }
      
      Logger.log(`[INFO] Procesando fragmento ${i+1} de ${uploadInfo.totalChunks}`);
      
      try {
        const chunkFile = DriveApp.getFileById(uploadInfo.chunkFiles[i]);
        const chunkBlob = chunkFile.getBlob();
        const chunkBytes = chunkBlob.getBytes();
        const chunkSize = chunkBytes.length;
        
        // Cálculo correcto del rango de bytes
        const rangeStart = totalBytesSent;
        
        // Si es el último fragmento, asegurarse de que el rango termine exactamente en fileSize-1
        if (i === uploadInfo.totalChunks - 1) {
          const rangeEnd = uploadInfo.fileSize - 1;
          const expectedLastChunkSize = uploadInfo.fileSize - totalBytesSent;
          
          Logger.log(`[INFO] Último fragmento - Tamaño actual: ${chunkSize}, esperado: ${expectedLastChunkSize}`);
          
          // Si el tamaño del último fragmento no coincide con lo esperado, ajustarlo
          if (chunkSize !== expectedLastChunkSize) {
            Logger.log(`[WARN] Ajustando tamaño del último fragmento`);
            
            const contentRange = `bytes ${rangeStart}-${rangeEnd}/${uploadInfo.fileSize}`;
            Logger.log(`[INFO] Rango final ajustado: ${contentRange}`);
            
            // Ajustar el tamaño del payload para el último fragmento
            const adjustedBytes = new Array(expectedLastChunkSize);
            const bytesToCopy = Math.min(chunkSize, expectedLastChunkSize);
            
            // Copiar solo los bytes necesarios del fragmento original
            for (let j = 0; j < bytesToCopy; j++) {
              adjustedBytes[j] = chunkBytes[j];
            }
            
            // Enviar el fragmento con el tamaño ajustado
            const uploadResponse = UrlFetchApp.fetch(newSessionUrl, {
              method: 'PUT',
              headers: {
                'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
                'Content-Range': contentRange
              },
              payload: adjustedBytes,
              muteHttpExceptions: true
            });
            
            const responseCode = uploadResponse.getResponseCode();
            Logger.log(`[INFO] Último fragmento - Código de respuesta: ${responseCode}`);
            
            if (responseCode !== 200 && responseCode !== 201) {
              throw new Error(`Error en el último fragmento: ${uploadResponse.getContentText()}`);
            }
            
            // Procesar la respuesta exitosa del último fragmento
            const fileData = JSON.parse(uploadResponse.getContentText());
            return finalizeCombineProcess(uploadId, fileData, uploadInfo);
            
          } else {
            // El tamaño coincide, continuar con la subida normal
            const contentRange = `bytes ${rangeStart}-${rangeEnd}/${uploadInfo.fileSize}`;
            Logger.log(`[INFO] Último fragmento - Rango: ${contentRange}`);
            
            const uploadResponse = UrlFetchApp.fetch(newSessionUrl, {
              method: 'PUT',
              headers: {
                'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
                'Content-Range': contentRange
              },
              payload: chunkBytes,
              muteHttpExceptions: true
            });
            
            const responseCode = uploadResponse.getResponseCode();
            Logger.log(`[INFO] Último fragmento - Código de respuesta: ${responseCode}`);
            
            if (responseCode !== 200 && responseCode !== 201) {
              throw new Error(`Error en el último fragmento: ${uploadResponse.getContentText()}`);
            }
            
            // Procesar la respuesta exitosa del último fragmento
            const fileData = JSON.parse(uploadResponse.getContentText());
            return finalizeCombineProcess(uploadId, fileData, uploadInfo);
          }
        } else {
          // Para fragmentos intermedios
          const rangeEnd = Math.min(rangeStart + chunkSize - 1, totalSize - 1);
          const contentRange = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
          
          Logger.log(`[INFO] Fragmento ${i+1} - Rango: ${contentRange}`);
          
          // Subir fragmento intermedio
          const uploadResponse = UrlFetchApp.fetch(newSessionUrl, {
            method: 'PUT',
            headers: {
              'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
              'Content-Range': contentRange
            },
            payload: chunkBytes,
            muteHttpExceptions: true
          });
          
          const responseCode = uploadResponse.getResponseCode();
          Logger.log(`[INFO] Fragmento ${i+1} - Código de respuesta: ${responseCode}`);
          
          // Para fragmentos intermedios, esperamos 308 (Resume Incomplete)
          if (responseCode !== 308) {
            throw new Error(`Error en fragmento ${i+1}: ${uploadResponse.getContentText()}`);
          }
          
          // Actualizar contadores y progreso
          totalBytesSent += chunkSize;
          uploadInfo.lastProcessedChunk = i;
          uploadInfo.bytesSent = totalBytesSent;
          userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
          
          Logger.log(`[INFO] Fragmento ${i+1} procesado correctamente. Bytes enviados: ${totalBytesSent}`);
        }
      } catch (error) {
        Logger.log(`[ERROR] Error en fragmento ${i+1}: ${error.toString()}`);
        
        // Si es el intento final, propagar el error
        if (isFinalAttempt) {
          throw error;
        }
        
        // Si no es intento final, guardar progreso para reanudar
        return {
          status: 'combine-error',
          uploadId: uploadId,
          nextChunk: uploadInfo.totalChunks,
          fileName: uploadInfo.fileName,
          totalChunks: uploadInfo.totalChunks,
          percentComplete: Math.round(((i) / uploadInfo.totalChunks) * 100),
          lastProcessedChunk: i - 1,
          message: `Error en fragmento ${i+1}. Intente finalizar manualmente.`
        };
      }
    }
    
    // No deberíamos llegar aquí, pero por si acaso
    Logger.log('[WARN] Se llegó al final del bucle sin completar la subida');
    return {
      status: 'combine-error',
      uploadId: uploadId,
      message: 'No se pudo completar la subida por una razón inesperada'
    };
    
  } catch (error) {
    Logger.log(`[ERROR] Error general en combineChunks: ${error.toString()}`);
    return {
      status: 'error',
      message: 'Error al combinar fragmentos: ' + error.toString()
    };
  }
}

/**
 * Función auxiliar para finalizar el proceso de combinación
 * @param {string} uploadId - ID de la sesión
 * @param {Object} fileData - Datos del archivo creado
 * @param {Object} uploadInfo - Información de la subida
 * @return {Object} - Estado de la finalización
 */
function finalizeCombineProcess(uploadId, fileData, uploadInfo) {
  const userProps = PropertiesService.getUserProperties();
  
  Logger.log(`[SUCCESS] Archivo ${fileData.name} combinado exitosamente: ${fileData.id}`);
  
  // Limpiar todos los archivos temporales
  Logger.log('[INFO] Limpiando archivos temporales...');
  for (let j = 0; j < uploadInfo.chunkFiles.length; j++) {
    if (uploadInfo.chunkFiles[j]) {
      try {
        DriveApp.getFileById(uploadInfo.chunkFiles[j]).setTrashed(true);
        Logger.log(`[DEBUG] Fragmento ${j+1} eliminado`);
      } catch (e) {
        Logger.log(`[WARN] Error al eliminar fragmento ${j+1}: ${e.toString()}`);
      }
    }
  }
  
  // Eliminar el archivo temporal inicial si existía
  if (uploadInfo.tempFileId) {
    try {
      DriveApp.getFileById(uploadInfo.tempFileId).setTrashed(true);
      Logger.log('[DEBUG] Archivo temporal inicial eliminado');
    } catch (e) {
      Logger.log(`[WARN] Error al eliminar archivo temporal: ${e.toString()}`);
    }
  }
  
  // Limpiar información de la subida
  userProps.deleteProperty(uploadId);
  Logger.log('[INFO] Sesión limpiada de userProperties');
  
  return {
    status: 'complete',
    fileId: fileData.id,
    fileName: fileData.name,
    fileUrl: `https://drive.google.com/file/d/${fileData.id}/view`,
    message: 'Archivo subido completamente',
    percentComplete: 100
  };
}

/**
 * Completa la operación final de combinación de fragmentos
 * @param {Object} data - Datos para completar la operación
 * @return {Object} - Estado de la finalización
 */
function finalizeChunkedUpload(data) {
  try {
    const { uploadId } = data;
    return combineChunks(uploadId, true, false); // true para finalAttempt, false para isAutoRetry
  } catch (error) {
    Logger.log('Error en finalizeChunkedUpload: ' + error.toString());
    return {
      status: 'error',
      message: 'Error al finalizar la subida: ' + error.toString()
    };
  }
}

/**
 * Obtiene la lista de subidas en progreso
 * @return {Object} - Lista de subidas en progreso
 */
function getPendingUploads() {
  try {
    const userProps = PropertiesService.getUserProperties();
    const allProps = userProps.getProperties();
    const pendingUploads = [];
    
    for (const key in allProps) {
      try {
        const uploadInfo = JSON.parse(allProps[key]);
        if (uploadInfo.fileName && uploadInfo.nextChunk !== undefined) {
          pendingUploads.push({
            uploadId: key,
            fileName: uploadInfo.fileName,
            nextChunk: uploadInfo.nextChunk,
            totalChunks: uploadInfo.totalChunks,
            percentComplete: Math.round((uploadInfo.nextChunk / uploadInfo.totalChunks) * 100)
          });
        }
      } catch (e) {
        // Ignorar propiedades que no son subidas
      }
    }
    
    return {
      status: 'success',
      pendingUploads: pendingUploads
    };
  } catch (error) {
    Logger.log('Error en getPendingUploads: ' + error.toString());
    return {
      status: 'error',
      message: 'Error al obtener subidas pendientes: ' + error.toString()
    };
  }
}

/**
 * Cancela una subida en progreso
 * @param {Object} data - Datos de la subida a cancelar
 * @return {Object} - Estado de la cancelación
 */
function cancelUpload(data) {
  try {
    const { uploadId } = data;
    const userProps = PropertiesService.getUserProperties();
    
    // Obtener la información de la subida
    const uploadDataStr = userProps.getProperty(uploadId);
    if (!uploadDataStr) {
      return {
        status: 'error',
        message: 'La sesión de subida no existe o ha expirado'
      };
    }
    
    const uploadInfo = JSON.parse(uploadDataStr);
    
    // Eliminar el archivo temporal inicial si existe
    if (uploadInfo.tempFileId) {
      try {
        DriveApp.getFileById(uploadInfo.tempFileId).setTrashed(true);
      } catch (e) {
        // Ignorar errores al eliminar el archivo
      }
    }
    
    // Eliminar el archivo final parcialmente subido si existe
    if (uploadInfo.finalFileId) {
      try {
        DriveApp.getFileById(uploadInfo.finalFileId).setTrashed(true);
      } catch (e) {
        // Ignorar errores al eliminar el archivo
      }
    }
    
    // Eliminar la información de la subida
    userProps.deleteProperty(uploadId);
    
    return {
      status: 'success',
      message: 'Subida cancelada correctamente'
    };
  } catch (error) {
    Logger.log('Error en cancelUpload: ' + error.toString());
    return {
      status: 'error',
      message: 'Error al cancelar la subida: ' + error.toString()
    };
  }
}

/**
 * Continúa automáticamente una combinación que fue interrumpida por timeout
 * @param {Object} data - Datos para continuar la combinación
 * @return {Object} - Estado de la continuación
 */
function continueChunkCombination(data) {
  try {
    const { uploadId } = data;
    
    Logger.log(`[INFO] Reanudando combinación automáticamente para uploadId: ${uploadId}`);
    const userProps = PropertiesService.getUserProperties();
    
    // Obtener la información de la subida
    const uploadDataStr = userProps.getProperty(uploadId);
    if (!uploadDataStr) {
      Logger.log('[ERROR] Sesión de subida no encontrada al intentar continuar combinación');
      return {
        status: 'error',
        message: 'La sesión de subida no existe o ha expirado'
      };
    }
    
    const uploadInfo = JSON.parse(uploadDataStr);
    
    // Registrar información del estado actual
    Logger.log(`[INFO] Reanudando combinación desde fragmento ${uploadInfo.lastProcessedChunk + 1}, bytes enviados: ${uploadInfo.bytesSent}`);
    
    // Marcar esto como un reintento automático
    return combineChunks(uploadId, false, true);
  } catch (error) {
    Logger.log(`[ERROR] Error en continueChunkCombination: ${error.toString()}`);
    return {
      status: 'error',
      message: 'Error al continuar la combinación: ' + error.toString()
    };
  }
}