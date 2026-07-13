import { supabase } from '../config/supabaseClient.js';

export async function getMyTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, description, due_date, is_completed, completed_at, leads ( id, student_name )')
    .eq('is_deleted', false)
    .order('is_completed', { ascending: true })
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data;
}

export async function createTask({ title, description, dueDate, leadId }, currentUserId) {
  const { error } = await supabase
    .from('tasks')
    .insert({
      title, description: description || null, due_date: dueDate || null, lead_id: leadId || null,
      assigned_to_user_id: currentUserId, created_by: currentUserId, updated_by: currentUserId,
    });
  if (error) throw error;
}

export async function toggleTaskComplete(taskId, isCompleted) {
  const { error } = await supabase
    .from('tasks')
    .update({ is_completed: isCompleted, completed_at: isCompleted ? new Date().toISOString() : null })
    .eq('id', taskId);
  if (error) throw error;
}

export async function getMyOpenLeadsForTaskLink() {
  const { data, error } = await supabase
    .from('leads')
    .select('id, student_name')
    .eq('is_deleted', false)
    .order('student_name');
  if (error) throw error;
  return data;
}
