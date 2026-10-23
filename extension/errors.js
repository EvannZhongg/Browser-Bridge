const fields = ['input_dispatched', 'post_action', 'diagnostics'];

export function errorData(error) {
  const data = { error: error.message || String(error) };
  for (const key of fields) if (error[key] !== undefined) data[key] = error[key];
  return data;
}

export function errorFromData(data) {
  const error = new Error(String(data.error));
  for (const key of fields) if (data[key] !== undefined) error[key] = data[key];
  return error;
}
