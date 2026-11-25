# JobSpy service for a separate server (VPS). Build and run:
#   docker build -t leadgenai-jobspy jobspy-service
#   docker run -d --restart unless-stopped -p 8766:8766 -e JOBSPY_SERVICE_KEY=<secret> leadgenai-jobspy
# Put HTTPS in front of it (e.g. Caddy) before the app calls it over the internet.
FROM python:3.12-slim
RUN pip install --no-cache-dir python-jobspy==1.5.0
WORKDIR /app
COPY main.py .
ENV JOBSPY_SERVICE_HOST=0.0.0.0 JOBSPY_SERVICE_PORT=8766 PYTHONUNBUFFERED=1
USER nobody
EXPOSE 8766
CMD ["python", "main.py"]
