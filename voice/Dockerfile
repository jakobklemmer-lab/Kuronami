# Die Sprachschicht (S30/S31) — der einzige Python-Prozess des Systems.
#
# Er liegt bewusst in einem Container und nicht auf dem Rechner: Abschnitt 4.1 nennt Pipecat eine
# **Prozessgrenze, keinen zweiten Stack**, und eine Prozessgrenze hält besser, wenn der zweite
# Stack gar nicht erst auf dem Entwicklungsrechner installiert werden muss. Node bleibt Node.
FROM python:3.12-slim

WORKDIR /app

# Erst die Abhängigkeiten, dann der Quelltext: so bleibt die teure Schicht (pipecat samt
# onnxruntime für Silero) über Codeänderungen hinweg im Cache.
COPY voice/requirements.txt ./voice/requirements.txt
RUN pip install --no-cache-dir -r voice/requirements.txt

COPY voice/ ./voice/

# `voice.pipeline.app` wird als Modul gestartet, damit die Importe im Paket (`voice.pipeline.*`)
# dieselben sind wie im Test.
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

CMD ["python", "-m", "voice.pipeline.app"]
