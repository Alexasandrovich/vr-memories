FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY docker/web.conf /etc/nginx/conf.d/default.conf
COPY docs/ /usr/share/nginx/html/
EXPOSE 7860
