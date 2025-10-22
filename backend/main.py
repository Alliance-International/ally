
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import setup_firebase, setup_gemini_api, load_html_templates, setup_logging
from routers import router as api_router


setup_logging()
setup_firebase()
setup_gemini_api()
load_html_templates()


app = FastAPI()

origins = [
    "https://ally-vimd.onrender.com"  
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(api_router)

@app.get("/", include_in_schema=False)
async def root():
    return {"message": "Welcome to Ally - the future of AI meeting management!"}


#because of the way Render works, I decided to write this endpoint for periodic health checks to ensure the app stays awake and responsive - and avoid spinningdown issues
@app.api_route("/health", status_code=200, methods=["GET", "HEAD"])
async def health_check():
    """A simple endpoint for uptime monitoring."""
    return {"status": "ok"}




