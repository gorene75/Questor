--
-- PostgreSQL database dump
--

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: character_relational_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_relational_knowledge (
    quest_id text NOT NULL,
    holder_id text NOT NULL,
    subject_ref text NOT NULL,
    subject_object_id text,
    facts jsonb NOT NULL,
    disclosure_gate jsonb
);


--
-- Name: game_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_objects (
    id text NOT NULL,
    quest_id text NOT NULL,
    type text NOT NULL,
    resolved jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolved_at_ref text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: object_placement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.object_placement (
    session_id uuid NOT NULL,
    object_id text NOT NULL,
    location text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: player_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_knowledge (
    session_id uuid NOT NULL,
    object_id text NOT NULL,
    known jsonb DEFAULT '{}'::jsonb NOT NULL,
    merged_into text,
    source text
);


--
-- Name: quests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quests (
    id text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    graph jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quest_id text NOT NULL,
    quest_version integer NOT NULL,
    current_scene text NOT NULL,
    phase text NOT NULL,
    flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    characters jsonb DEFAULT '{}'::jsonb NOT NULL,
    invented jsonb DEFAULT '[]'::jsonb NOT NULL,
    transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
    scene_turn_count integer DEFAULT 0 NOT NULL,
    fired_beats jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    ending_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    model_name text,
    ending_trigger text,
    story_time text,
    active_degradations jsonb DEFAULT '[]'::jsonb NOT NULL,
    idle_turns integer DEFAULT 0 NOT NULL,
    progress_events jsonb DEFAULT '[]'::jsonb NOT NULL,
    checkpoint jsonb,
    save_slot jsonb
);


--
-- Name: turn_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_logs (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    turn_index integer NOT NULL,
    player_input text,
    prompt text NOT NULL,
    raw_response text NOT NULL,
    parsed jsonb,
    validation jsonb NOT NULL,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now(),
    model_call_ms integer,
    validation_ms integer,
    db_commit_ms integer,
    total_ms integer,
    model_call_count integer
);


--
-- Name: turn_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.turn_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: turn_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.turn_logs_id_seq OWNED BY public.turn_logs.id;


--
-- Name: turn_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_logs ALTER COLUMN id SET DEFAULT nextval('public.turn_logs_id_seq'::regclass);


--
-- Name: character_relational_knowledge character_relational_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_relational_knowledge
    ADD CONSTRAINT character_relational_knowledge_pkey PRIMARY KEY (quest_id, holder_id, subject_ref);


--
-- Name: game_objects game_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_objects
    ADD CONSTRAINT game_objects_pkey PRIMARY KEY (id);


--
-- Name: object_placement object_placement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_placement
    ADD CONSTRAINT object_placement_pkey PRIMARY KEY (session_id, object_id);


--
-- Name: player_knowledge player_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_knowledge
    ADD CONSTRAINT player_knowledge_pkey PRIMARY KEY (session_id, object_id);


--
-- Name: quests quests_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_id_version_key UNIQUE (id, version);


--
-- Name: quests quests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: turn_logs turn_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_logs
    ADD CONSTRAINT turn_logs_pkey PRIMARY KEY (id);


--
-- Name: character_relational_knowledge; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.character_relational_knowledge ENABLE ROW LEVEL SECURITY;

--
-- Name: game_objects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.game_objects ENABLE ROW LEVEL SECURITY;

--
-- Name: object_placement; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.object_placement ENABLE ROW LEVEL SECURITY;

--
-- Name: player_knowledge; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.player_knowledge ENABLE ROW LEVEL SECURITY;

--
-- Name: quests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quests ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: turn_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.turn_logs ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

