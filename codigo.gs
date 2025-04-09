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
    
    // Verificar que tengamos todos los fragmentos
    if (!uploadInfo.chunkFiles || uploadInfo.chunkFiles.length !== uploadInfo.totalChunks) {
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
    
    // Verificar tiempo de ejecución restante
    const startTime = new Date().getTime();
    const totalElapsedTime = startTime - uploadInfo.startTime;
    
    // Si estamos cerca del límite de tiempo y no es el intento final, programar un reintento automático
    if (totalElapsedTime > MAX_EXECUTION_TIME && !isFinalAttempt && uploadInfo.combineAttempts < 5) {
      Logger.log('Tiempo de ejecución excedido, programando reintento automático: ' + uploadInfo.combineAttempts);
      // Incrementar el contador de intentos para mantener seguimiento
      uploadInfo.combineAttempts = (uploadInfo.combineAttempts || 0) + 1;
      userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
      
      return {
        status: 'auto-combine',
        uploadId: uploadId,
        nextChunk: uploadInfo.totalChunks,
        fileName: uploadInfo.fileName,
        totalChunks: uploadInfo.totalChunks,
        percentComplete: 99,
        combineAttempts: uploadInfo.combineAttempts,
        message: 'Combinando fragmentos automáticamente...'
      };
    } else if (totalElapsedTime > MAX_EXECUTION_TIME && !isFinalAttempt && uploadInfo.combineAttempts >= 5) {
      // Después de varios intentos, sugerir finalización manual
      return {
        status: 'combine-timeout',
        uploadId: uploadId,
        nextChunk: uploadInfo.totalChunks,
        fileName: uploadInfo.fileName,
        totalChunks: uploadInfo.totalChunks,
        percentComplete: 99,
        message: 'Se alcanzó el límite de tiempo tras varios intentos. Por favor finalice manualmente.'
      };
    }
    
    // Registro para depuración
    Logger.log('Combinando chunks para uploadId: ' + uploadId + ' con ' + uploadInfo.totalChunks + ' fragmentos');
    
    try {
      // 1. Iniciar una carga resumible
      const fileMetadata = {
        name: uploadInfo.fileName,
        mimeType: uploadInfo.contentType,
        parents: [FOLDER_ID]
      };
      
      Logger.log('Iniciando carga resumible para ' + uploadInfo.fileName);
      
      // Iniciar la sesión de carga resumible
      const initiateResponse = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
          'Content-Type': 'application/json; charset=UTF-8'
        },
        payload: JSON.stringify(fileMetadata),
        muteHttpExceptions: true
      });
      
      // Verificar respuesta de inicialización
      if (initiateResponse.getResponseCode() !== 200) {
        throw new Error('Error al iniciar la sesión de carga resumible: ' + initiateResponse.getContentText());
      }
      
      // Obtener la URL de sesión de la respuesta
      const sessionUrl = initiateResponse.getHeaders()['Location'];
      if (!sessionUrl) {
        throw new Error('No se recibió la URL de sesión para la carga resumible');
      }
      
      Logger.log('URL de sesión obtenida correctamente');
      
      // 2. Subir cada fragmento a la ubicación correcta
      let totalBytesSent = 0;
      const totalSize = uploadInfo.fileSize;
      
      for (let i = 0; i < uploadInfo.totalChunks; i++) {
        if (!uploadInfo.chunkFiles[i]) {
          Logger.log('Fragmento ' + i + ' no encontrado, saltando');
          continue;
        }
        
        Logger.log('Procesando fragmento ' + (i+1) + ' de ' + uploadInfo.totalChunks);
        
        try {
          const chunkFile = DriveApp.getFileById(uploadInfo.chunkFiles[i]);
          const chunkBlob = chunkFile.getBlob();
          const chunkBytes = chunkBlob.getBytes();
          const chunkSize = chunkBytes.length;
          
          // Determinar el rango de bytes para este fragmento
          const rangeStart = totalBytesSent;
          const rangeEnd = Math.min(totalBytesSent + chunkSize - 1, totalSize - 1);
          const contentRange = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
          
          Logger.log(`Subiendo fragmento ${i+1}/${uploadInfo.totalChunks}, bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
          
          // Subir este fragmento
          const uploadResponse = UrlFetchApp.fetch(sessionUrl, {
            method: 'PUT',
            headers: {
              'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
              'Content-Range': contentRange
            },
            payload: chunkBytes,
            muteHttpExceptions: true
          });
          
          const responseCode = uploadResponse.getResponseCode();
          Logger.log(`Fragmento ${i+1} código de respuesta: ${responseCode}`);
          
          // Si es el último fragmento, deberíamos recibir un código 200 o 201
          if (i === uploadInfo.totalChunks - 1) {
            if (responseCode !== 200 && responseCode !== 201) {
              throw new Error('Error al finalizar la carga: ' + uploadResponse.getContentText());
            }
            
            // El último fragmento debe devolver los metadatos del archivo
            const fileData = JSON.parse(uploadResponse.getContentText());
            Logger.log('Archivo combinado exitosamente: ' + fileData.id);
            
            // Limpiar todos los archivos temporales
            Logger.log('Limpiando archivos temporales...');
            for (let j = 0; j < uploadInfo.chunkFiles.length; j++) {
              if (uploadInfo.chunkFiles[j]) {
                try {
                  DriveApp.getFileById(uploadInfo.chunkFiles[j]).setTrashed(true);
                } catch (e) {
                  Logger.log('Error al eliminar fragmento ' + j + ': ' + e.toString());
                  // Continuar a pesar del error
                }
              }
            }
            
            // Eliminar el archivo temporal inicial si existía
            if (uploadInfo.tempFileId) {
              try {
                DriveApp.getFileById(uploadInfo.tempFileId).setTrashed(true);
              } catch (e) {
                Logger.log('Error al eliminar archivo temporal inicial: ' + e.toString());
                // Continuar a pesar del error
              }
            }
            
            // Limpiar información de la subida
            userProps.deleteProperty(uploadId);
            
            return {
              status: 'complete',
              fileId: fileData.id,
              fileName: fileData.name,
              fileUrl: `https://drive.google.com/file/d/${fileData.id}/view`,
              message: 'Archivo subido completamente',
              percentComplete: 100
            };
          } 
          else if (responseCode !== 308) {
            // Para fragmentos intermedios, esperamos un código 308 (Resume Incomplete)
            throw new Error(`Error al subir fragmento ${i}: respuesta ${responseCode} ${uploadResponse.getContentText()}`);
          }
          
          // Actualizar el contador de bytes enviados
          totalBytesSent += chunkSize;
          
          // Actualizar estado de progreso para futuras referencias
          uploadInfo.lastProcessedChunk = i;
          uploadInfo.bytesSent = totalBytesSent;
          userProps.setProperty(uploadId, JSON.stringify(uploadInfo));
          
        } catch (chunkError) {
          Logger.log('Error al procesar fragmento ' + i + ': ' + chunkError.toString());
          
          // Si estamos en intento final, informar el error
          if (isFinalAttempt) {
            throw chunkError;
          }
          
          // Si no es intento final, devolver estado de error para reintento
          return {
            status: 'combine-error',
            uploadId: uploadId,
            nextChunk: uploadInfo.totalChunks,
            fileName: uploadInfo.fileName,
            totalChunks: uploadInfo.totalChunks,
            percentComplete: 99,
            lastProcessedChunk: i,
            message: 'Error al combinar fragmento ' + (i+1) + '. Intente finalizar manualmente.'
          };
        }
      }
      
      // No deberíamos llegar aquí, pero por si acaso
      throw new Error('Error inesperado: no se completó la carga resumible');
      
    } catch (e) {
      Logger.log('Error en la carga resumible: ' + e.toString());
      
      // Limpiar fragmentos temporales solo en caso de error fatal
      if (isFinalAttempt) {
        for (let i = 0; i < uploadInfo.chunkFiles.length; i++) {
          if (uploadInfo.chunkFiles[i]) {
            try {
              DriveApp.getFileById(uploadInfo.chunkFiles[i]).setTrashed(true);
            } catch (cleanupError) {
              // Ignorar errores de limpieza
              Logger.log('Error al limpiar fragmento ' + i + ': ' + cleanupError.toString());
            }
          }
        }
        
        // Limpiar archivo temporal inicial
        if (uploadInfo.tempFileId) {
          try {
            DriveApp.getFileById(uploadInfo.tempFileId).setTrashed(true);
          } catch (cleanupError) {
            // Ignorar errores de limpieza
            Logger.log('Error al limpiar archivo temporal: ' + cleanupError.toString());
          }
        }
        
        // Limpiar información de la subida
        userProps.deleteProperty(uploadId);
      } else {
        // En caso de error pero no en intento final, devolver estado para reintento
        return {
          status: 'combine-error',
          uploadId: uploadId,
          nextChunk: uploadInfo.totalChunks,
          fileName: uploadInfo.fileName,
          totalChunks: uploadInfo.totalChunks,
          percentComplete: 99,
          message: 'Error al combinar fragmentos. Intente finalizar manualmente: ' + e.toString()
        };
      }
      
      throw new Error('Error en la carga resumible: ' + e.toString());
    }
  } catch (error) {
    Logger.log('Error en combineChunks: ' + error.toString());
    return {
      status: 'error',
      message: 'Error al combinar fragmentos: ' + error.toString()
    };
  }
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
