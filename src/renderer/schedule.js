(() => {
  'use strict';

  const api = window.scheduleApi;
  const username = new URLSearchParams(location.search).get('u') ?? '';
  const field = (id) => document.getElementById(id);
  const errorBox = field('error');

  function showError(error) {
    const text = String(error?.message ?? error).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      '',
    );
    errorBox.textContent = text;
    errorBox.classList.remove('d-none');
  }

  function fill(config) {
    field('timeInput').value = config?.timeValue ?? '';
    field('startDateInput').value = config?.startDateValue ?? '';
    field('endDateInput').value = config?.endDateValue ?? '';
    field('lower').value = config?.durationMinutesValueLower ?? '';
    field('higher').value = config?.durationMinutesValueHigher ?? '';
  }

  field('who').textContent = username;
  api.get(username).then(fill, showError);

  field('scheduleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('d-none');
    const config = {
      timeValue: field('timeInput').value,
      startDateValue: field('startDateInput').value,
      endDateValue: field('endDateInput').value,
      durationMinutesValueLower: Number.parseInt(field('lower').value, 10),
      durationMinutesValueHigher: Number.parseInt(field('higher').value, 10),
    };
    try {
      await api.save(username, config); // the main process closes this window on success
    } catch (error) {
      showError(error);
    }
  });

  field('removeSchedule').addEventListener('click', async () => {
    errorBox.classList.add('d-none');
    try {
      await api.remove(username);
      fill(null);
    } catch (error) {
      showError(error);
    }
  });
})();
