-- ==============================================
-- Migration 097: Admins borran mensajes ajenos
-- ==============================================
-- En grupos, el dueño y los admins pueden borrar un mensaje de otra persona.
-- El mensaje NO se elimina de la fila: se vacía el cifrado y se marca quién lo
-- retiró, para que el hilo muestre «Ana eliminó este mensaje» en su lugar
-- (si se borrara la fila, el hueco rompería el orden y las respuestas).
--
-- No hace falta política nueva: la política "Update conversation messages"
-- (migración 033) ya deja a cualquier participante actualizar la fila; quién
-- puede hacerlo se limita en el cliente a owner/admin.
-- ==============================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
