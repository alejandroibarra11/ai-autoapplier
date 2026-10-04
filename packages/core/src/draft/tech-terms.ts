export const TECH_TERMS: string[] = [
  // languages
  'Python', 'Go', 'Golang', 'Rust', 'Java', 'Kotlin', 'Scala', 'C#', 'C++', 'Ruby', 'PHP', 'Elixir', 'Erlang', 'Haskell', 'Clojure',
  'Objective-C', 'Dart', 'Perl', 'Lua', 'Julia', 'MATLAB', 'Bash', 'PowerShell', 'Solidity', 'Zig', 'OCaml', 'F#',
  'TypeScript', 'JavaScript', 'SQL', 'HTML', 'CSS', 'Sass', 'WebAssembly',
  // frontend
  'React', 'React Native', 'Vue', 'Svelte', 'SvelteKit', 'Angular', 'Next.js', 'Nuxt', 'Gatsby', 'Astro', 'jQuery',
  'Redux', 'Tailwind', 'Bootstrap', 'Webpack', 'Vite', 'Flutter', 'Ionic', 'Electron', 'Storybook',
  // backend
  'Node.js', 'Deno', 'NestJS', 'Fastify', 'Django', 'Flask', 'FastAPI', 'Rails', 'Ruby on Rails', 'Laravel', 'Symfony',
  'Spring Boot', '.NET', 'ASP.NET', 'Actix', 'Tokio', 'GraphQL', 'gRPC', 'REST', 'WebSocket', 'tRPC',
  'Celery', 'Sidekiq', 'RabbitMQ', 'Kafka', 'NATS', 'Pulsar',
  // databases
  'PostgreSQL', 'Postgres', 'MySQL', 'MariaDB', 'SQLite', 'MongoDB', 'Redis', 'Cassandra', 'DynamoDB', 'Elasticsearch', 'OpenSearch',
  'Neo4j', 'CockroachDB', 'ClickHouse', 'Snowflake', 'BigQuery', 'Redshift', 'Supabase', 'Firebase', 'Prisma', 'Drizzle', 'SQLAlchemy',
  'Pinecone', 'Weaviate', 'Qdrant', 'Milvus', 'Chroma', 'pgvector',
  // data
  'Spark', 'Hadoop', 'Airflow', 'dbt', 'Flink', 'Databricks', 'Pandas', 'NumPy', 'Dagster', 'Prefect', 'Tableau', 'Looker', 'Power BI',
  // cloud / devops
  'AWS', 'GCP', 'Azure', 'Google Cloud', 'Cloudflare', 'Vercel', 'Netlify', 'Heroku', 'DigitalOcean', 'EC2', 'S3',
  'Kubernetes', 'Docker', 'Terraform', 'Ansible', 'Pulumi', 'Helm', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'CircleCI', 'ArgoCD',
  'Prometheus', 'Grafana', 'Datadog', 'Sentry', 'New Relic', 'OpenTelemetry', 'Nginx', 'Linux', 'Istio',
  // AI / ML
  'TensorFlow', 'PyTorch', 'Keras', 'scikit-learn', 'JAX', 'Hugging Face', 'Transformers', 'LangChain', 'LangGraph', 'LlamaIndex',
  'OpenAI', 'Anthropic', 'Claude', 'GPT-4', 'ChatGPT', 'Gemini', 'Llama', 'Mistral', 'Cohere', 'Ollama', 'vLLM', 'CrewAI', 'AutoGen',
  'RAG', 'MLflow', 'Kubeflow', 'SageMaker', 'Vertex AI', 'Bedrock', 'Stable Diffusion', 'OpenCV', 'spaCy', 'NLTK',
  'Machine Learning', 'ML', 'Deep Learning', 'NLP', 'Computer Vision',
  // voice / telephony
  'Twilio', 'Vapi', 'Retell', 'ElevenLabs', 'Deepgram', 'AssemblyAI', 'LiveKit', 'Pipecat', 'Vonage', 'Telnyx', 'Plivo',
  'Asterisk', 'FreeSWITCH', 'WebRTC', 'SIP', 'Agora',
  // other tools
  'Git', 'GitHub', 'GitLab', 'Jira', 'Stripe', 'Auth0', 'Okta', 'Salesforce', 'HubSpot', 'Zapier', 'n8n', 'Shopify',
  'Jest', 'Vitest', 'Pytest', 'Cypress', 'Playwright', 'Selenium', 'Puppeteer', 'Figma', 'Postman', 'Swagger',
];

/** Terms that are also ordinary words or abbreviations; the backstop scan matches these case-sensitively. */
export const CASE_SENSITIVE_TERMS = new Set<string>([
  'Go', 'ML', 'Rust', 'Java', 'Git', 'Spark', 'Ruby', 'Dart', 'Lua', 'Zig', 'Perl', 'REST', 'SIP', 'RAG', 'Sass', 'Vite',
  'Helm', 'Jest', 'Astro', 'Sentry', 'Claude', 'Transformers', 'Gemini', 'Llama', 'Mistral', 'Vault', 'Gin', 'Express',
]);
